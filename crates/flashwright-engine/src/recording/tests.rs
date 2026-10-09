use super::*;
use std::time::Duration;

#[test]
fn seal_fences_whole_groups_and_late_phases_stay_with_the_original_chunk() {
    let mut state = RecordingState::default();
    state.start("recording").unwrap();
    let recording = state.get_mut("recording").unwrap();
    recording.start_chunk("first").unwrap();
    recording.observed_group(10);
    assert!(
        recording
            .admit_phase("first", "call", SnapshotPhase::Before)
            .unwrap()
    );
    assert!(
        !recording
            .admit_phase("first", "call", SnapshotPhase::Before)
            .unwrap()
    );
    assert_eq!(
        recording.seal_chunk("first").unwrap()["lastEventSequence"],
        10
    );
    recording.observed_group(20);
    assert_eq!(
        recording.seal_chunk("first").unwrap()["lastEventSequence"],
        10
    );
    assert!(
        !recording
            .admit_phase("first", "call", SnapshotPhase::After)
            .unwrap()
    );
    assert!(recording.start_chunk("second").is_err());
    recording
        .settle_phase("first", "call", SnapshotPhase::Before)
        .unwrap();
    recording.start_chunk("second").unwrap();
    assert!(
        !recording
            .admit_phase("first", "call", SnapshotPhase::Input)
            .unwrap()
    );
    assert!(
        recording
            .settle_phase("first", "call", SnapshotPhase::Before)
            .is_err()
    );
    assert!(
        recording
            .admit_phase("second", "new-call", SnapshotPhase::Before)
            .unwrap()
    );
    recording
        .settle_phase("second", "new-call", SnapshotPhase::Before)
        .unwrap();
    assert_eq!(
        recording.seal_chunk("second").unwrap()["lastEventSequence"],
        20
    );
    assert!(recording.start_chunk("first").is_err());
    state.stop("recording").unwrap();
    assert!(state.start("recording").is_err());
}

#[test]
fn clock_preserves_pre_epoch_ingress_and_recording_continues_through_chunk_gaps() {
    let mut state = RecordingState::default();
    state.start("recording").unwrap();
    let recording = state.get_mut("recording").unwrap();
    assert_eq!(
        recording.native_time(recording.epoch - Duration::from_millis(25)),
        -25.0
    );
    assert_eq!(
        recording.native_time(recording.epoch + Duration::from_millis(40)),
        40.0
    );
    recording.observed_group(7);
    recording.start_chunk("first").unwrap();
    assert_eq!(
        recording.seal_chunk("first").unwrap()["lastEventSequence"],
        7
    );
    recording.observed_group(8);
    recording.start_chunk("second").unwrap();
    assert_eq!(
        recording.seal_chunk("second").unwrap()["lastEventSequence"],
        8
    );
}

#[test]
fn identity_pressure_fails_the_original_recording_without_dropping_pending_owners() {
    let mut state = RecordingState::default();
    state.start("recording").unwrap();
    let recording = state.get_mut("recording").unwrap();
    recording.start_chunk("chunk").unwrap();
    for index in 0..MAXIMUM_CALLS {
        assert!(
            recording
                .admit_phase("chunk", &format!("call-{index}"), SnapshotPhase::Before)
                .unwrap()
        );
    }
    assert_eq!(
        recording
            .admit_phase("chunk", "overflow", SnapshotPhase::Before)
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert!(recording.chunk.as_ref().unwrap().pending());
    assert!(state.stop("recording").is_err());
    let recording = state.get_mut("recording").unwrap();
    for index in 0..MAXIMUM_CALLS {
        recording
            .settle_phase("chunk", &format!("call-{index}"), SnapshotPhase::Before)
            .unwrap();
    }
    assert_eq!(
        state.stop("recording").unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    state.start("successor-recording").unwrap();
}

#[test]
fn failed_or_closed_recording_still_settles_original_async_commit_owners() {
    for close in [false, true] {
        let mut state = RecordingState::default();
        state.start("recording").unwrap();
        let recording = state.get_mut("recording").unwrap();
        recording.start_chunk("chunk").unwrap();
        recording
            .admit_phase("chunk", "call", SnapshotPhase::Before)
            .unwrap();
        if close {
            state.close();
        } else {
            state.get_mut("recording").unwrap().fail(ErrorRecord::new(
                ErrorCode::Protocol,
                "tracing.snapshot",
                "host writer failed",
            ));
        }
        let recording = state.get_mut("recording").unwrap();
        assert!(
            recording
                .snapshot_commit_finished("chunk", "capture", Ok(()))
                .is_err()
        );
        recording
            .settle_phase("chunk", "call", SnapshotPhase::Before)
            .unwrap();
        assert!(!recording.chunk.as_ref().unwrap().pending());
        assert!(state.stop("recording").is_err());
        if close {
            assert!(state.start("successor").is_err());
        } else {
            state.start("successor").unwrap();
        }
    }
}

#[test]
fn failed_archive_keeps_retirement_status_readable_until_original_phase_settles() {
    let mut state = RecordingState::default();
    state.start("recording").unwrap();
    let recording = state.get_mut("recording").unwrap();
    recording.start_chunk("chunk").unwrap();
    recording
        .admit_phase("chunk", "call", SnapshotPhase::Before)
        .unwrap();
    recording.fail(ErrorRecord::new(
        ErrorCode::Protocol,
        "tracing.snapshot",
        "controlled write failure",
    ));
    assert!(recording.original_chunk("chunk").unwrap().pending());
    assert!(
        recording
            .original_chunk("chunk")
            .unwrap()
            .snapshots
            .pull()
            .is_err()
    );
    recording
        .settle_phase("chunk", "call", SnapshotPhase::Before)
        .unwrap();
    assert!(!recording.original_chunk("chunk").unwrap().pending());
    assert!(recording.original_chunk("successor").is_err());
}

#[test]
fn failed_network_archive_still_seals_and_retires_with_its_original_failure() {
    let mut state = RecordingState::default();
    state.start("recording").unwrap();
    let recording = state.get_mut("recording").unwrap();
    recording.network = Some(network::NetworkRecording::new(
        recording.epoch,
        Arc::new(network::NetworkBudget::default()),
    ));
    recording.start_chunk("chunk").unwrap();
    recording.observed_group(17);
    recording
        .admit_phase("chunk", "call", SnapshotPhase::Before)
        .unwrap();
    recording.fail(ErrorRecord::new(
        ErrorCode::ResourceLimit,
        "tracing.snapshot",
        "original snapshot limit",
    ));
    assert_eq!(
        recording.seal_chunk("chunk").unwrap()["lastEventSequence"],
        17
    );
    recording.observed_group(23);
    assert_eq!(
        recording.seal_chunk("chunk").unwrap()["lastEventSequence"],
        17
    );
    assert!(recording.original_chunk("chunk").unwrap().pending());
    assert!(state.stop("recording").is_err());
    let recording = state.get_mut("recording").unwrap();
    recording
        .settle_phase("chunk", "call", SnapshotPhase::Before)
        .unwrap();
    let error = state.stop("recording").unwrap_err();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert_eq!(error.message.as_ref(), "original snapshot limit");
    state.start("successor").unwrap();
}

#[test]
fn failure_while_sealing_network_does_not_prevent_the_lifecycle_fence() {
    let mut state = RecordingState::default();
    state.start("recording").unwrap();
    let recording = state.get_mut("recording").unwrap();
    recording.network = Some(network::NetworkRecording::new(
        recording.epoch,
        Arc::new(network::NetworkBudget::default()),
    ));
    recording.start_chunk("chunk").unwrap();
    recording.observed_group(19);
    recording
        .network
        .as_mut()
        .unwrap()
        .recording_failed(&ErrorRecord::new(
            ErrorCode::ResourceLimit,
            "tracing.network",
            "network metadata limit",
        ));
    assert_eq!(
        recording.seal_chunk("chunk").unwrap()["lastEventSequence"],
        19
    );
    assert!(!recording.original_chunk("chunk").unwrap().accepting);
    assert_eq!(
        recording.failure.as_ref().unwrap().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(
        state.stop("recording").unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    state.start("successor").unwrap();
}
