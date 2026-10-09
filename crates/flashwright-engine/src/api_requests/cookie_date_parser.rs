// Copyright 2011 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the compatibility/upstream/LICENSE.v8-date-parser file.
//
// Rust port of Node v22.22.0's deps/v8/src/date/dateparser{,-inl}.{h,cc}.
// Provenance and changes: compatibility/upstream/api-request-date-provenance.json.

//! Allocation-free V8 date-string grammar for API cookie expiry.
//!
//! Parsing leaves calendar normalization, local-time conversion, and ECMAScript
//! TimeClip to the caller. Legacy parsing deliberately retains V8's permissive
//! grammar and partially consumed ISO fallback state.

use std::str::Chars;

const MAXIMUM_SIGNIFICANT_DIGITS: usize = 9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ParsedDate {
    pub(super) year: i32,
    pub(super) month: u32,
    pub(super) day: u32,
    pub(super) hour: u32,
    pub(super) minute: u32,
    pub(super) second: u32,
    pub(super) millisecond: u32,
    pub(super) timezone_offset_seconds: Option<i32>,
}

/// Parse the pinned V8 ISO/legacy grammar, stopping at the first NUL character.
pub(super) fn parse(value: &str) -> Option<ParsedDate> {
    let mut scanner = DateStringTokenizer::new(value);
    let mut date = DayComposer::default();
    let mut time = TimeComposer::default();
    let mut timezone = TimeZoneComposer::default();
    let mut token = parse_iso_date_time(&mut scanner, &mut date, &mut time, &mut timezone);
    if token.kind == TokenKind::Invalid {
        return None;
    }
    let mut has_read_number = !date.is_empty();
    while token.kind != TokenKind::EndOfInput {
        if token.is_number() {
            has_read_number = true;
            let number = token.value;
            if scanner.skip_symbol(':') {
                if scanner.skip_symbol(':') {
                    if !time.is_empty() {
                        return None;
                    }
                    time.add(number);
                    time.add(0);
                } else {
                    if !time.add(number) {
                        return None;
                    }
                    if scanner.peek().is_symbol('.') {
                        scanner.next();
                    }
                }
            } else if scanner.skip_symbol('.') && time.is_expecting(number) {
                time.add(number);
                if !scanner.peek().is_number() {
                    return None;
                }
                let milliseconds = read_milliseconds(scanner.next());
                time.add_final(milliseconds);
            } else if timezone.is_expecting(number) {
                timezone.minute = Some(number);
            } else if time.is_expecting(number) {
                time.add_final(number);
                let next_token = scanner.peek();
                if next_token.kind != TokenKind::EndOfInput
                    && next_token.kind != TokenKind::Whitespace
                    && !next_token.is_keyword_z()
                    && !next_token.is_ascii_sign()
                {
                    return None;
                }
            } else {
                if !date.add(number) {
                    return None;
                }
                scanner.skip_symbol('-');
            }
        } else if let TokenKind::Keyword(keyword) = token.kind {
            match keyword {
                KeywordKind::AmPm if !time.is_empty() => time.hour_offset = Some(token.value),
                KeywordKind::MonthName => {
                    date.named_month = Some(token.value);
                    scanner.skip_symbol('-');
                }
                KeywordKind::TimeZoneName if has_read_number => timezone.set(token.value),
                _ => {
                    if has_read_number || scanner.peek().is_number() {
                        return None;
                    }
                }
            }
        } else if token.is_ascii_sign() && (timezone.is_utc() || !time.is_empty()) {
            timezone.sign = Some(token.ascii_sign());
            let mut number = 0;
            let mut length = 0;
            if scanner.peek().is_number() {
                let next_token = scanner.next();
                length = next_token.length;
                number = next_token.value;
            }
            has_read_number = true;
            if scanner.peek().is_symbol(':') {
                // V8 leaves ':' for the next iteration and resets only minutes.
                timezone.hour = Some(number);
                timezone.minute = None;
            } else if length == 1 || length == 2 {
                timezone.hour = Some(number);
                timezone.minute = Some(0);
            } else if length == 3 || length == 4 {
                timezone.hour = Some(number / 100);
                timezone.minute = Some(number % 100);
            } else {
                return None;
            }
        } else if (token.is_ascii_sign() || token.is_symbol(')')) && has_read_number {
            return None;
        }
        token = scanner.next();
    }
    let (year, month, day) = date.finish()?;
    let [hour, minute, second, millisecond] = time.finish()?;
    Some(ParsedDate {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
        timezone_offset_seconds: timezone.finish()?,
    })
}

/// Return the first unhandled token for legacy fallback, or terminal ISO status.
fn parse_iso_date_time(
    scanner: &mut DateStringTokenizer<'_>,
    date: &mut DayComposer,
    time: &mut TimeComposer,
    timezone: &mut TimeZoneComposer,
) -> DateToken {
    if scanner.peek().is_ascii_sign() {
        let sign_token = scanner.next();
        if !scanner.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = scanner.next().value;
        if sign < 0 && year == 0 {
            return sign_token;
        }
        date.add(sign * year);
    } else if scanner.peek().is_fixed_length_number(4) {
        date.add(scanner.next().value);
    } else {
        return scanner.next();
    }
    if scanner.skip_symbol('-') {
        if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().value) {
            return scanner.next();
        }
        date.add(scanner.next().value);
        if scanner.skip_symbol('-') {
            if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().value) {
                return scanner.next();
            }
            date.add(scanner.next().value);
        }
    }
    if scanner.peek().kind != TokenKind::Keyword(KeywordKind::TimeSeparator) {
        if scanner.peek().kind != TokenKind::EndOfInput {
            return scanner.next();
        }
    } else {
        scanner.next();
        if !scanner.peek().is_fixed_length_number(2) || !(0..=24).contains(&scanner.peek().value) {
            return DateToken::invalid();
        }
        let hour_is_24 = scanner.peek().value == 24;
        time.add(scanner.next().value);
        if !scanner.skip_symbol(':') {
            return DateToken::invalid();
        }
        if !scanner.peek().is_fixed_length_number(2)
            || !is_minute(scanner.peek().value)
            || (hour_is_24 && scanner.peek().value > 0)
        {
            return DateToken::invalid();
        }
        time.add(scanner.next().value);
        if scanner.skip_symbol(':') {
            if !scanner.peek().is_fixed_length_number(2)
                || !is_second(scanner.peek().value)
                || (hour_is_24 && scanner.peek().value > 0)
            {
                return DateToken::invalid();
            }
            time.add(scanner.next().value);
            if scanner.skip_symbol('.') {
                if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().value > 0) {
                    return DateToken::invalid();
                }
                time.add(read_milliseconds(scanner.next()));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            timezone.set(0);
        } else if scanner.peek().is_ascii_sign() {
            timezone.sign = Some(scanner.next().ascii_sign());
            if scanner.peek().is_fixed_length_number(4) {
                let hour_and_minute = scanner.next().value;
                let hour = hour_and_minute / 100;
                let minute = hour_and_minute % 100;
                if !is_hour(hour) || !is_minute(minute) {
                    return DateToken::invalid();
                }
                timezone.hour = Some(hour);
                timezone.minute = Some(minute);
            } else {
                if !scanner.peek().is_fixed_length_number(2) || !is_hour(scanner.peek().value) {
                    return DateToken::invalid();
                }
                timezone.hour = Some(scanner.next().value);
                if !scanner.skip_symbol(':') {
                    return DateToken::invalid();
                }
                if !scanner.peek().is_fixed_length_number(2) || !is_minute(scanner.peek().value) {
                    return DateToken::invalid();
                }
                timezone.minute = Some(scanner.next().value);
            }
        }
        if scanner.peek().kind != TokenKind::EndOfInput {
            return DateToken::invalid();
        }
    }
    if timezone.hour.is_none() && time.is_empty() {
        timezone.set(0);
    }
    date.is_iso_date = true;
    DateToken::end_of_input()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeywordKind {
    Invalid,
    MonthName,
    TimeZoneName,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    Invalid,
    Unknown,
    Whitespace,
    Number,
    Symbol,
    EndOfInput,
    Keyword(KeywordKind),
}

#[derive(Clone, Copy, Debug)]
struct DateToken {
    kind: TokenKind,
    length: usize,
    value: i32,
}

impl DateToken {
    fn invalid() -> Self {
        Self {
            kind: TokenKind::Invalid,
            length: 0,
            value: -1,
        }
    }

    fn end_of_input() -> Self {
        Self {
            kind: TokenKind::EndOfInput,
            length: 0,
            value: -1,
        }
    }

    fn is_number(self) -> bool {
        self.kind == TokenKind::Number
    }

    fn is_fixed_length_number(self, length: usize) -> bool {
        self.is_number() && self.length == length
    }

    fn is_symbol(self, symbol: char) -> bool {
        self.kind == TokenKind::Symbol && self.value == symbol as i32
    }

    fn is_ascii_sign(self) -> bool {
        self.is_symbol('+') || self.is_symbol('-')
    }

    fn ascii_sign(self) -> i32 {
        if self.is_symbol('-') { -1 } else { 1 }
    }

    fn is_keyword_z(self) -> bool {
        self.kind == TokenKind::Keyword(KeywordKind::TimeZoneName)
            && self.length == 1
            && self.value == 0
    }
}

struct InputReader<'value> {
    remaining: Chars<'value>,
    current: char,
    position: usize,
}

impl<'value> InputReader<'value> {
    fn new(value: &'value str) -> Self {
        let mut reader = Self {
            remaining: value.chars(),
            current: '\0',
            position: 0,
        };
        reader.next();
        reader
    }

    fn next(&mut self) {
        self.current = self.remaining.next().unwrap_or('\0');
        self.position += 1;
    }

    fn read_unsigned_numeral(&mut self) -> i32 {
        let mut number = 0;
        let mut significant_digits = 0;
        while self.current == '0' {
            self.next();
        }
        while self.current.is_ascii_digit() {
            if significant_digits < MAXIMUM_SIGNIFICANT_DIGITS {
                number = number * 10 + (self.current as i32 - '0' as i32);
            }
            significant_digits += 1;
            self.next();
        }
        number
    }

    fn read_word(&mut self) -> ([u32; 3], usize) {
        let mut prefix = [0; 3];
        let mut length = 0;
        while self.current >= 'A' && !is_whitespace(self.current) {
            if length < prefix.len() {
                // V8 uses a bitwise ASCII case fold even for non-ASCII input.
                prefix[length] = self.current as u32 | 0x20;
            }
            length += 1;
            self.next();
        }
        (prefix, length)
    }

    fn skip_whitespace(&mut self) -> bool {
        if !is_whitespace(self.current)
            && !matches!(self.current, '\n' | '\r' | '\u{2028}' | '\u{2029}')
        {
            return false;
        }
        self.next();
        true
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.current != '(' {
            return false;
        }
        let mut balance = 0usize;
        loop {
            match self.current {
                '(' => balance += 1,
                ')' => balance -= 1,
                _ => (),
            }
            self.next();
            if balance == 0 || self.current == '\0' {
                return true;
            }
        }
    }
}

struct DateStringTokenizer<'value> {
    reader: InputReader<'value>,
    next_token: DateToken,
}

impl<'value> DateStringTokenizer<'value> {
    fn new(value: &'value str) -> Self {
        let mut tokenizer = Self {
            reader: InputReader::new(value),
            next_token: DateToken::end_of_input(),
        };
        tokenizer.next_token = tokenizer.scan();
        tokenizer
    }

    fn next(&mut self) -> DateToken {
        let result = self.next_token;
        self.next_token = self.scan();
        result
    }

    fn peek(&self) -> DateToken {
        self.next_token
    }

    fn skip_symbol(&mut self, symbol: char) -> bool {
        if !self.next_token.is_symbol(symbol) {
            return false;
        }
        self.next_token = self.scan();
        true
    }

    fn scan(&mut self) -> DateToken {
        let starting_position = self.reader.position;
        if self.reader.current == '\0' {
            return DateToken::end_of_input();
        }
        if self.reader.current.is_ascii_digit() {
            let number = self.reader.read_unsigned_numeral();
            return DateToken {
                kind: TokenKind::Number,
                length: self.reader.position - starting_position,
                value: number,
            };
        }
        if matches!(self.reader.current, ':' | '-' | '+' | '.' | ')') {
            let symbol = self.reader.current;
            self.reader.next();
            return DateToken {
                kind: TokenKind::Symbol,
                length: 1,
                value: symbol as i32,
            };
        }
        if self.reader.current >= 'A' && !is_whitespace(self.reader.current) {
            let (prefix, length) = self.reader.read_word();
            let (keyword, value) = lookup_keyword(prefix, length);
            return DateToken {
                kind: TokenKind::Keyword(keyword),
                length,
                value,
            };
        }
        if self.reader.skip_whitespace() {
            return DateToken {
                kind: TokenKind::Whitespace,
                length: self.reader.position - starting_position,
                value: -1,
            };
        }
        if !self.reader.skip_parentheses() {
            self.reader.next();
        }
        DateToken {
            kind: TokenKind::Unknown,
            length: 1,
            value: -1,
        }
    }
}

/// ECMAScript WhiteSpace (Unicode Zs plus TAB, VT, FF, and BOM).
fn is_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\u{000b}' | '\u{000c}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn lookup_keyword(prefix: [u32; 3], length: usize) -> (KeywordKind, i32) {
    const KEYWORDS: [([u8; 3], KeywordKind, i32); 27] = [
        (*b"jan", KeywordKind::MonthName, 1),
        (*b"feb", KeywordKind::MonthName, 2),
        (*b"mar", KeywordKind::MonthName, 3),
        (*b"apr", KeywordKind::MonthName, 4),
        (*b"may", KeywordKind::MonthName, 5),
        (*b"jun", KeywordKind::MonthName, 6),
        (*b"jul", KeywordKind::MonthName, 7),
        (*b"aug", KeywordKind::MonthName, 8),
        (*b"sep", KeywordKind::MonthName, 9),
        (*b"oct", KeywordKind::MonthName, 10),
        (*b"nov", KeywordKind::MonthName, 11),
        (*b"dec", KeywordKind::MonthName, 12),
        (*b"am\0", KeywordKind::AmPm, 0),
        (*b"pm\0", KeywordKind::AmPm, 12),
        (*b"ut\0", KeywordKind::TimeZoneName, 0),
        (*b"utc", KeywordKind::TimeZoneName, 0),
        (*b"z\0\0", KeywordKind::TimeZoneName, 0),
        (*b"gmt", KeywordKind::TimeZoneName, 0),
        (*b"cdt", KeywordKind::TimeZoneName, -5),
        (*b"cst", KeywordKind::TimeZoneName, -6),
        (*b"edt", KeywordKind::TimeZoneName, -4),
        (*b"est", KeywordKind::TimeZoneName, -5),
        (*b"mdt", KeywordKind::TimeZoneName, -6),
        (*b"mst", KeywordKind::TimeZoneName, -7),
        (*b"pdt", KeywordKind::TimeZoneName, -7),
        (*b"pst", KeywordKind::TimeZoneName, -8),
        (*b"t\0\0", KeywordKind::TimeSeparator, 0),
    ];
    for (keyword_prefix, kind, value) in KEYWORDS {
        if prefix == keyword_prefix.map(u32::from)
            && (length <= 3 || kind == KeywordKind::MonthName)
        {
            return (kind, value);
        }
    }
    (KeywordKind::Invalid, 0)
}

fn read_milliseconds(token: DateToken) -> i32 {
    match token.length {
        1 => token.value * 100,
        2 => token.value * 10,
        3 => token.value,
        length => token.value / 10_i32.pow((length.min(MAXIMUM_SIGNIFICANT_DIGITS) - 3) as u32),
    }
}

fn is_month(number: i32) -> bool {
    (1..=12).contains(&number)
}
fn is_day(number: i32) -> bool {
    (1..=31).contains(&number)
}
fn is_hour(number: i32) -> bool {
    (0..=23).contains(&number)
}
fn is_minute(number: i32) -> bool {
    (0..=59).contains(&number)
}
fn is_second(number: i32) -> bool {
    (0..=59).contains(&number)
}

#[derive(Default)]
struct DayComposer {
    components: [i32; 3],
    length: usize,
    named_month: Option<i32>,
    is_iso_date: bool,
}

impl DayComposer {
    fn is_empty(&self) -> bool {
        self.length == 0
    }

    fn add(&mut self, number: i32) -> bool {
        if self.length == self.components.len() {
            return false;
        }
        self.components[self.length] = number;
        self.length += 1;
        true
    }

    fn finish(mut self) -> Option<(i32, u32, u32)> {
        if self.is_empty() {
            return None;
        }
        while self.length < self.components.len() {
            self.add(1);
        }
        let [first, second, third] = self.components;
        let (mut year, month, day) = match self.named_month {
            None if self.is_iso_date || !is_day(first) => (first, second, third),
            None => (third, first, second),
            Some(month) if !is_day(first) => (first, month, second),
            Some(month) => (second, month, first),
        };
        if !self.is_iso_date {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        if !is_month(month) || !is_day(day) {
            return None;
        }
        // Scanner values never exceed nine significant digits, so all parsed
        // years fit both V8's 31-bit and 32-bit Smi representations.
        Some((year, month as u32, day as u32))
    }
}

#[derive(Default)]
struct TimeComposer {
    components: [i32; 4],
    length: usize,
    hour_offset: Option<i32>,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.length == 0
    }

    fn is_expecting(&self, number: i32) -> bool {
        match self.length {
            1 => is_minute(number),
            2 => is_second(number),
            3 => (0..=999).contains(&number),
            _ => false,
        }
    }

    fn add(&mut self, number: i32) -> bool {
        if self.length == self.components.len() {
            return false;
        }
        self.components[self.length] = number;
        self.length += 1;
        true
    }

    fn add_final(&mut self, number: i32) -> bool {
        if !self.add(number) {
            return false;
        }
        while self.length < self.components.len() {
            self.add(0);
        }
        true
    }

    fn finish(mut self) -> Option<[u32; 4]> {
        while self.length < self.components.len() {
            self.add(0);
        }
        let [mut hour, minute, second, millisecond] = self.components;
        if let Some(offset) = self.hour_offset {
            if !(0..=12).contains(&hour) {
                return None;
            }
            hour = hour % 12 + offset;
        }
        if (!is_hour(hour)
            || !is_minute(minute)
            || !is_second(second)
            || !(0..=999).contains(&millisecond))
            && !(hour == 24 && minute == 0 && second == 0 && millisecond == 0)
        {
            return None;
        }
        Some([
            hour as u32,
            minute as u32,
            second as u32,
            millisecond as u32,
        ])
    }
}

#[derive(Default)]
struct TimeZoneComposer {
    sign: Option<i32>,
    hour: Option<i32>,
    minute: Option<i32>,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_hours: i32) {
        let sign = if offset_hours < 0 { -1 } else { 1 };
        self.sign = Some(sign);
        self.hour = Some(offset_hours * sign);
        self.minute = Some(0);
    }

    fn is_utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }

    fn is_expecting(&self, number: i32) -> bool {
        self.hour.is_some() && self.minute.is_none() && is_minute(number)
    }

    fn finish(self) -> Option<Option<i32>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        // Match V8's unsigned arithmetic and the pinned Node build's 32-bit
        // Smi bound, including wrapping in permissive legacy offsets.
        let total_seconds = (self.hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute.unwrap_or(0) as u32).wrapping_mul(60));
        if total_seconds > i32::MAX as u32 {
            return None;
        }
        Some(Some(total_seconds as i32 * sign))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i32, month: u32, day: u32, timezone: Option<i32>) -> ParsedDate {
        ParsedDate {
            year,
            month,
            day,
            hour: 0,
            minute: 0,
            second: 0,
            millisecond: 0,
            timezone_offset_seconds: timezone,
        }
    }

    #[test]
    fn iso_date_defaults_and_expanded_years() {
        for (input, expected) in [
            ("2024", date(2024, 1, 1, Some(0))),
            ("2024-02", date(2024, 2, 1, Some(0))),
            ("0000-01-01", date(0, 1, 1, Some(0))),
            ("+000000-01-01", date(0, 1, 1, Some(0))),
            ("-000001-01-01", date(-1, 1, 1, Some(0))),
            ("+999999-12-31", date(999999, 12, 31, Some(0))),
        ] {
            assert_eq!(parse(input), Some(expected), "{input}");
        }
        assert_eq!(parse("-000000"), None);
    }

    #[test]
    fn date_time_without_timezone_remains_local() {
        assert_eq!(parse("2024-01-02T00:00"), Some(date(2024, 1, 2, None)));
        assert_eq!(parse("2024-01-02t00:00z"), Some(date(2024, 1, 2, Some(0))));
        for (suffix, expected_offset) in [("+0530", 19800), ("-05:30", -19800), ("+23:59", 86340)] {
            let input = format!("2024-01-02T03:04:05{suffix}");
            let mut expected = date(2024, 1, 2, Some(expected_offset));
            expected.hour = 3;
            expected.minute = 4;
            expected.second = 5;
            assert_eq!(parse(&input), Some(expected), "{input}");
        }
    }

    #[test]
    fn iso_time_commits_to_strict_validation() {
        for input in [
            "2024-01-02T0:00",
            "2024-01-02T00:0",
            "2024-01-02T24:01",
            "2024-01-02T24:00:01",
            "2024-01-02T24:00:00.0001",
            "2024-01-02T00:00:60",
            "2024-01-02T00:00:00.",
            "2024-01-02T00:00+24:00",
            "2024-01-02T00:00+01",
            "2024-01-02T00:00+010",
            "2024-01-02T00:00+01:60",
            "2024-01-02T00:00Z ",
            "2024-01-02T00:00Z(comment)",
        ] {
            assert_eq!(parse(input), None, "{input}");
        }
        let mut expected = date(2024, 1, 2, Some(0));
        expected.hour = 24;
        assert_eq!(parse("2024-01-02T24:00:00.000Z"), Some(expected));
    }

    #[test]
    fn fractional_seconds_keep_the_pinned_significant_digit_rules() {
        for (fraction, millisecond) in [
            ("1", 100),
            ("12", 120),
            ("123", 123),
            ("123456789123", 123),
            ("0001", 0),
            ("000000000123456789", 123),
        ] {
            let input = format!("2024-01-02T03:04:05.{fraction}Z");
            let mut expected = date(2024, 1, 2, Some(0));
            expected.hour = 3;
            expected.minute = 4;
            expected.second = 5;
            expected.millisecond = millisecond;
            assert_eq!(parse(&input), Some(expected), "{input}");
        }
    }

    #[test]
    fn iso_date_fallback_keeps_consumed_components() {
        assert_eq!(parse("2024-1-2"), Some(date(2024, 1, 2, None)));
        assert_eq!(parse("2024-01-02 "), Some(date(2024, 1, 2, None)));
        assert_eq!(parse("2024-01-02 GMT"), Some(date(2024, 1, 2, Some(0))));
        assert_eq!(parse("2024-01-02Tgarbage"), None);
        // Calendar overflow is normalized by the caller, not the grammar.
        assert_eq!(parse("2024-02-31"), Some(date(2024, 2, 31, Some(0))));
    }

    #[test]
    fn legacy_names_and_two_digit_years_follow_v8_ordering() {
        for (input, expected) in [
            ("Wed, 01 Jan 1970 00:00:00 GMT", date(1970, 1, 1, Some(0))),
            ("Januaryanything 01 1970", date(1970, 1, 1, None)),
            ("01-JAN-49", date(2049, 1, 1, None)),
            ("01 Jan 50", date(1950, 1, 1, None)),
            ("1/2/03", date(2003, 1, 2, None)),
            ("1", date(2001, 1, 1, None)),
            ("Jan 1", date(2001, 1, 1, None)),
            ("1970 Jan 1", date(1970, 1, 1, None)),
            ("January 1970 1", date(1970, 1, 1, None)),
        ] {
            assert_eq!(parse(input), Some(expected), "{input}");
        }
    }

    #[test]
    fn legacy_time_and_named_offsets_remain_permissive() {
        for (input, hour, minute, second, millisecond, offset) in [
            ("1 Jan 1970 12:00 am", 0, 0, 0, 0, None),
            ("1 Jan 1970 12:00 pm", 12, 0, 0, 0, None),
            ("1 Jan 1970 0:00 pm", 12, 0, 0, 0, None),
            ("1 Jan 1970 5::06 GMT", 5, 0, 6, 0, Some(0)),
            ("1 Jan 1970 5:06:07.89 EST", 5, 6, 7, 890, Some(-18000)),
            ("1 Jan 1970 5:06:07 GMT+8", 5, 6, 7, 0, Some(28800)),
            ("1 Jan 1970 5:06:07 +1260", 5, 6, 7, 0, Some(46800)),
            ("1 Jan 1970 5:06:07 +25:30", 5, 6, 7, 0, Some(91800)),
        ] {
            let mut expected = date(1970, 1, 1, offset);
            expected.hour = hour;
            expected.minute = minute;
            expected.second = second;
            expected.millisecond = millisecond;
            assert_eq!(parse(input), Some(expected), "{input}");
        }
        assert_eq!(parse("1 Jan 1970 13:00 pm"), None);
        assert_eq!(parse("1 Jan 1970 5:06:07GMT"), None);
        assert_eq!(parse("1 Jan 1970 5:06:07 +12345"), None);
    }

    #[test]
    fn garbage_parentheses_and_nul_obey_scanner_boundaries() {
        for input in [
            "garbage word 1 Jan 1970 GMT",
            ") + - garbage 1 Jan 1970 GMT",
            "1 Jan 1970 GMT (outer (nested) text)",
            "1 Jan 1970 GMT (unfinished",
            "1 Jan 1970 GMT\0garbage 2024",
            "1970-01-01\0T25:61Z",
        ] {
            assert_eq!(parse(input), Some(date(1970, 1, 1, Some(0))), "{input}");
        }
        for input in [
            "garbage1 Jan 1970",
            "1 garbage Jan 1970",
            "1 Jan 1970)",
            "1 Jan 1970 -",
            "Jan",
            "",
            "\0Jan 1 1970",
        ] {
            assert_eq!(parse(input), None, "{input}");
        }
    }

    #[test]
    fn whitespace_uses_ecmascript_character_classes() {
        for separator in [
            '\t', '\n', '\r', '\u{000b}', '\u{000c}', ' ', '\u{00a0}', '\u{1680}', '\u{2000}',
            '\u{200a}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            let input = format!("1{separator}Jan{separator}1970{separator}GMT");
            assert_eq!(parse(&input), Some(date(1970, 1, 1, Some(0))), "{input:?}");
        }
        for separator in ['\u{0085}', '\u{180e}', '\u{2028}', '\u{2029}'] {
            let input = format!("1{separator}Jan{separator}1970{separator}GMT");
            assert_eq!(parse(&input), None, "{input:?}");
        }
        assert_eq!(parse("１ Jan 1970"), Some(date(1970, 1, 1, None)));
        assert_eq!(parse("1 Jan １970"), None);
    }

    #[test]
    fn enormous_tokens_are_consumed_without_numeric_overflow() {
        let zeros = "0".repeat(100_000);
        assert_eq!(
            parse(&format!("{zeros}1 Jan 1970 GMT")),
            Some(date(1970, 1, 1, Some(0)))
        );
        assert_eq!(
            parse(&format!("{} Jan 1 GMT", "9".repeat(100_000))),
            Some(date(999999999, 1, 1, Some(0)))
        );
        assert_eq!(
            parse(&format!("{} 1 Jan 1970 GMT", "unrecognized".repeat(10_000))),
            Some(date(1970, 1, 1, Some(0)))
        );
        assert_eq!(
            parse(&format!("1 Jan 1970 GMT {}", "(".repeat(100_000))),
            Some(date(1970, 1, 1, Some(0)))
        );
        assert_eq!(parse("1 Jan 1970 00:00 GMT+600000:00"), None);
        assert_eq!(
            parse("1 Jan 1970 00:00 GMT+999999999:00"),
            Some(date(1970, 1, 1, Some(817402352)))
        );
    }
}
