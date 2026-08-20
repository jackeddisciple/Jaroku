// The backend and everything it spawned, treated as one thing.
//
// THE BUG. `sidecar.rs` spawns `jaroku-node cli.mjs index.ts`, and that is not the server. `tsx`'s
// CLI is a launcher: it re-executes Node with its own loader and preflight hooks as a CHILD, and
// that grandchild is the process that opens the port, the database and the run pool. On a real
// installation the tree is
//
//     jaroku.exe
//       └─ jaroku-node.exe  …/tsx/dist/cli.mjs  …/server/src/index.ts        ← the child we hold
//            └─ jaroku-node.exe  --import …/loader.mjs  …/server/src/index.ts ← the actual server
//
// and `CommandChild::kill` is `TerminateProcess` on the first of those. On Windows that is the
// whole of what a kill can be for a console-less child, so quitting Jaroku killed the launcher and
// left the server running: still listening on 4317, still holding the SQLite write-ahead log, and
// still able to answer `/healthz` to anything that asked. Verified by killing the shell and
// watching both node processes stay up with the port bound.
//
// AND THAT IS WHERE THE FREEZE CAME FROM. The next launch probed 4317, found it "free" for the
// reason ports.rs now explains at length, handed it to a new backend that could not bind it, and
// the app came up dead. Two bugs, one symptom, and neither visible without a log.
//
// The orphan does eventually die — its stdout pipe is gone, so the next line it writes takes the
// process down with an unhandled EPIPE. "Eventually" is the problem: it is the next time the
// server logs anything, which is milliseconds on a busy backend and minutes on an idle one, and
// the relaunch either lands inside that window or does not. That is precisely the shape of a bug
// somebody describes as "sometimes it works".
//
// WHAT WINDOWS ACTUALLY OFFERS FOR THIS is a job object, which is the operating system's own name
// for "this process and its descendants". A process assigned to one drags everything it spawns in
// after it, `TerminateJobObject` ends the whole set, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
// makes the set die with the handle — so an orphan cannot outlive the shell even when the shell
// is killed from Task Manager and never gets to run a line of shutdown code. That last property
// is why this is a job rather than a walk of the process table: a tree-kill only helps on the
// paths where our own code still runs, and the paths where it does not are the ones that were
// leaving the orphans.
//
// OFF WINDOWS THIS IS NOTHING, deliberately. `sidecar::stop` sends SIGTERM, and tsx's CLI installs
// `SIGINT`/`SIGTERM` handlers that relay to its child and escalate to `SIGKILL` after five seconds
// — checked in `server/node_modules/tsx/dist/cli.mjs` rather than assumed, because the whole point
// of this module is that the Windows half of that assumption was false. So on macOS and Linux the
// signal reaches the real server, its own handler drains the ingest chain, and there is nothing
// here to add.

/// Bind a freshly spawned backend, and everything it goes on to spawn, to this application.
///
/// Called immediately after the spawn returns. There is a race in principle — the child could
/// spawn its own child before it is assigned — and in practice the grandchild appears once Node
/// has booted, which is two orders of magnitude later than this call.
pub fn adopt(pid: u32) {
    imp::adopt(pid);
}

/// End the backend and everything it spawned, now.
///
/// Idempotent, and safe to call when nothing is running: a job with no processes in it terminates
/// successfully and stays usable, which is what lets the supervisor clear the previous generation
/// before starting the next one.
pub fn terminate() {
    imp::terminate();
}

#[cfg(not(windows))]
mod imp {
    pub fn adopt(_pid: u32) {}
    pub fn terminate() {}
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    use crate::logs;

    /// A job handle, and the reason it needs a wrapper: `HANDLE` is a raw pointer and therefore
    /// neither `Send` nor `Sync`, while this one is created once on the main thread and used from
    /// the supervisor's task. A Windows kernel handle is an index into a per-process table and is
    /// valid from any thread in the process, which is what makes the assertion below true rather
    /// than merely convenient.
    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    /// Created on first use and never closed by us. Closing it is what kills the backend, so the
    /// only close that should ever happen is the one the operating system does when this process
    /// ends — which is exactly the guarantee this module is for.
    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<&'static Job> {
        JOB.get_or_init(|| {
            // Safety: an unnamed job with default security. Both arguments are the documented
            // "no preference" nulls, and the return value is checked for the null the API uses to
            // report failure.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                logs::say("this session would not give the shell a job object; a crash may leave the backend running");
                return None;
            }

            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // Safety: `limits` is the struct this information class is defined to take, its size
            // is taken from the type rather than written out, and the pointer is valid for the
            // duration of the call.
            let set = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set == 0 {
                // The job still works for an explicit terminate; what is lost is the guarantee
                // that a crash takes the backend with it. Worth a line, not worth refusing.
                logs::say(format!(
                    "the shell's job object would not take kill-on-close ({}); a crash may leave the backend running",
                    std::io::Error::last_os_error()
                ));
            }
            Some(Job(handle))
        })
        .as_ref()
    }

    pub fn adopt(pid: u32) {
        let Some(job) = job() else { return };
        // PROCESS_SET_QUOTA is what assignment to a job actually requires; PROCESS_TERMINATE is
        // what terminating the job requires of its members. Asking for those two and nothing else
        // is the difference between a handle that can do this job and a handle that can do
        // anything to that process.
        //
        // Safety: a pid this process spawned moments ago, and a handle closed on every path below.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            logs::say(format!("could not hold on to backend pid {pid}: {}", std::io::Error::last_os_error()));
            return;
        }
        let assigned = unsafe { AssignProcessToJobObject(job.0, process) };
        if assigned == 0 {
            logs::say(format!(
                "backend pid {pid} could not be bound to this application ({}); quitting may leave it running",
                std::io::Error::last_os_error()
            ));
        } else {
            logs::detail(format!("backend pid {pid} and its descendants are bound to this application"));
        }
        unsafe { CloseHandle(process) };
    }

    pub fn terminate() {
        let Some(job) = job() else { return };
        // Safety: a handle this module created and never closes. The exit code is what the
        // members are reported to have exited with, and 1 is the conventional "killed".
        let ended = unsafe { TerminateJobObject(job.0, 1) };
        if ended == 0 {
            logs::say(format!("could not end the backend's process group: {}", std::io::Error::last_os_error()));
        } else {
            logs::detail("the backend and everything it spawned have been ended");
        }
    }
}
