//! Convert the pinned date grammar into clipped Unix milliseconds without allocation.

use super::cookie_date_parser;

const MAXIMUM_TIME_MILLISECONDS: i64 = 8_640_000_000_000_000;
const SECONDS_PER_DAY: i64 = 86_400;

#[derive(Debug, PartialEq)]
pub(super) enum DateValue {
    Invalid,
    Milliseconds(f64),
    Local([i32; 7]),
}

pub(super) fn classify(value: &str) -> DateValue {
    let Some(date) = cookie_date_parser::parse(value) else {
        return DateValue::Invalid;
    };
    if !(-300_000..=300_000).contains(&date.year) {
        return DateValue::Invalid;
    }
    let wall_milliseconds = (days_since_epoch(date.year, date.month, date.day) * SECONDS_PER_DAY
        + i64::from(date.hour) * 3600
        + i64::from(date.minute) * 60
        + i64::from(date.second))
        * 1000
        + i64::from(date.millisecond);
    if let Some(offset) = date.timezone_offset_seconds {
        let milliseconds = wall_milliseconds - i64::from(offset) * 1000;
        if milliseconds.abs() <= MAXIMUM_TIME_MILLISECONDS {
            DateValue::Milliseconds(milliseconds as f64)
        } else {
            DateValue::Invalid
        }
    } else if wall_milliseconds.abs() > MAXIMUM_TIME_MILLISECONDS + 30 * SECONDS_PER_DAY * 1000 {
        DateValue::Invalid
    } else {
        DateValue::Local([
            date.year,
            date.month as i32,
            date.day as i32,
            date.hour as i32,
            date.minute as i32,
            date.second as i32,
            date.millisecond as i32,
        ])
    }
}

/// Month overflow is rejected by the parser; valid day 29–31 can roll into the next month.
fn days_since_epoch(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year);
    let previous_year = year - 1;
    let leap_days =
        previous_year.div_euclid(4) - 1969_i64.div_euclid(4) - previous_year.div_euclid(100)
            + 1969_i64.div_euclid(100)
            + previous_year.div_euclid(400)
            - 1969_i64.div_euclid(400);
    let month_days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    (year - 1970) * 365
        + leap_days
        + month_days[(month - 1) as usize]
        + i64::from(leap_year && month > 2)
        + i64::from(day)
        - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(value: &str) -> Option<f64> {
        match classify(value) {
            DateValue::Milliseconds(value) => Some(value),
            _ => None,
        }
    }

    #[test]
    fn calendar_handles_epoch_negative_years_leaps_and_overflow_days() {
        assert_eq!(days_since_epoch(1970, 1, 1), 0);
        assert_eq!(days_since_epoch(1969, 12, 31), -1);
        assert_eq!(
            days_since_epoch(2000, 3, 1) - days_since_epoch(2000, 2, 28),
            2
        );
        assert_eq!(
            days_since_epoch(1900, 3, 1) - days_since_epoch(1900, 2, 28),
            1
        );
        assert_eq!(days_since_epoch(0, 3, 1) - days_since_epoch(0, 2, 28), 2);
        assert_eq!(days_since_epoch(2027, 2, 30), days_since_epoch(2027, 3, 2));
    }

    #[test]
    fn explicit_offsets_milliseconds_and_time_clip_use_original_values() {
        assert_eq!(parse("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(parse("1969-12-31T23:59:59.999Z"), Some(-1.0));
        assert_eq!(parse("1970-01-01T01:00:00+01:00"), Some(0.0));
        assert_eq!(
            parse("+275760-09-13T00:00:00Z"),
            Some(MAXIMUM_TIME_MILLISECONDS as f64)
        );
        assert_eq!(parse("+275760-09-13T00:00:00.001Z"), None);
        assert_eq!(
            parse("-271821-04-20T00:00:00Z"),
            Some(-MAXIMUM_TIME_MILLISECONDS as f64)
        );
        assert_eq!(parse("-271821-04-19T23:59:59.999Z"), None);
    }

    #[test]
    fn local_values_require_the_actual_host_timezone_database() {
        assert_eq!(
            classify("2030-01-02T03:04:05.006"),
            DateValue::Local([2030, 1, 2, 3, 4, 5, 6])
        );
        assert_eq!(classify("+999999-01-01T00:00"), DateValue::Invalid);
    }
}
