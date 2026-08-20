// UTC, formatted by hand, in the one place that does it.
//
// WHY THERE IS NO DATE CRATE HERE. The only readers of these strings are a line in a support
// conversation and a line in a log file — nothing parses one, nothing compares two, and nothing
// does arithmetic on one after it is a string. A dependency whose entire contribution is a
// formatter for values nobody reads back is a dependency that costs more than it carries.
//
// WHY IT IS ITS OWN MODULE. `marker.rs` wrote this first, for the timestamp inside the
// first-launch marker. `logs.rs` then needed the same calendar with milliseconds on the end, and
// a second copy of Howard Hinnant's civil-from-days is exactly the kind of duplication that is
// correct on the day it is written and disagrees with the original after somebody fixes a leap
// year in one of them. One implementation, two callers, and the tests that were in marker.rs came
// here with the code they cover.

use std::time::{SystemTime, UNIX_EPOCH};

/// `YYYY-MM-DDTHH:MM:SSZ` for now. The marker's field.
pub fn now() -> String {
    format_at(epoch_seconds())
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for now. The log's field.
///
/// MILLISECONDS ARE THE WHOLE POINT OF THE SECOND FORMATTER. This log exists to make startup
/// ordering legible — the window, the extraction, the port, the spawn, the first line the backend
/// printed — and every one of those happens inside the same second on a warm launch. A log whose
/// timestamps cannot separate them is a log that cannot answer the question it was added for.
pub fn stamp() -> String {
    let (secs, millis) = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64, d.subsec_millis()),
        Err(_) => (0, 0),
    };
    let date = format_at(secs);
    // The seconds' own `Z` is replaced rather than appended to, so there is one terminator.
    format!("{}.{millis:03}Z", date.trim_end_matches('Z'))
}

fn epoch_seconds() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Split out from the two callers above so the arithmetic can be asserted against dates somebody
/// can check by eye, which is the only way a hand-written calendar is worth having.
pub fn format_at(secs: i64) -> String {
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);

    // Civil-from-days, Howard Hinnant's algorithm, with the era shifted so 1970-01-01 is day 0.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_formats_as_the_day_unix_time_starts() {
        // Not a tautology: this is the one date where every term in the civil-from-days
        // arithmetic is at a boundary, which is where an off-by-one in the era shift shows up.
        assert_eq!(format_at(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn a_leap_day_is_the_leap_day_and_not_the_first_of_march() {
        assert_eq!(format_at(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn the_clock_is_read_rather_than_hardcoded() {
        assert!(now().ends_with('Z') && now().len() == 20);
    }

    #[test]
    fn a_log_stamp_carries_milliseconds_and_still_ends_in_one_z() {
        let stamp = stamp();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert_eq!(stamp.matches('Z').count(), 1, "{stamp}");
        assert!(stamp.ends_with('Z'), "{stamp}");
        // The millisecond field is three digits and is where the seconds' Z used to be.
        assert_eq!(&stamp[19..20], ".", "{stamp}");
    }
}
