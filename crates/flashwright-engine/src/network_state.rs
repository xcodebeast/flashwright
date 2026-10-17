//! Occurrence-owned history and bounded pairing of Chromium's independent header events.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Write};
use std::sync::Arc;

use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::network_observer::{NetworkIngress, NetworkObservation, NetworkTransition};
use crate::network_request::RequestState;

pub(crate) const ENGINE_NETWORK_BYTES: usize = 256 * 1024 * 1024;
const PAGE_NETWORK_BYTES: usize = 64 * 1024 * 1024;
const MAXIMUM_UNFINISHED_REQUESTS: usize = 4096;
const MAXIMUM_COMPLETED_REQUESTS: usize = 1024;
const MAXIMUM_HEADER_RECORDS: usize = 4096;
const METHOD: &str = "network.observe";

#[derive(Clone, Copy)]
pub(crate) enum HeaderKind {
    Request,
    Response,
}

struct HeaderRecord {
    headers: Value,
    ingress: NetworkIngress,
    bytes: usize,
}

#[derive(Default)]
struct HeaderChain {
    requests: VecDeque<HeaderRecord>,
    responses: VecDeque<HeaderRecord>,
    request_targets: VecDeque<String>,
    response_targets: VecDeque<String>,
    finished: bool,
}

pub(crate) struct NetworkRequests {
    occurrences: HashMap<String, RequestState>,
    latest: HashMap<String, String>,
    navigation_aliases: HashMap<String, String>,
    completed: VecDeque<String>,
    live_loaders: HashSet<String>,
    unfinished: usize,
    header_chains: HashMap<String, HeaderChain>,
    header_records: usize,
    budget: Arc<Semaphore>,
    reservation: Option<OwnedSemaphorePermit>,
}

impl Default for NetworkRequests {
    fn default() -> Self {
        Self::new(Arc::new(Semaphore::new(ENGINE_NETWORK_BYTES)))
    }
}

impl NetworkRequests {
    /// All public pages share the engine allowance; a page additionally enforces its own cap.
    pub(crate) fn new(budget: Arc<Semaphore>) -> Self {
        Self {
            occurrences: HashMap::new(),
            latest: HashMap::new(),
            navigation_aliases: HashMap::new(),
            completed: VecDeque::new(),
            live_loaders: HashSet::new(),
            unfinished: 0,
            header_chains: HashMap::new(),
            header_records: 0,
            budget,
            reservation: None,
        }
    }

    /// Body and navigation lookups follow only the latest occurrence of the protocol identifier.
    pub(crate) fn get(&self, identifier: &str) -> Option<&RequestState> {
        self.latest
            .get(identifier)
            .and_then(|identity| self.occurrences.get(identity))
    }

    pub(crate) fn occurrence(&self, identity: &str) -> Option<&RequestState> {
        self.occurrences.get(identity)
    }

    pub(crate) fn owns_response(&self, request: &RequestState) -> bool {
        self.latest
            .get(&crate::network_request::request_key(
                &request.response_session,
                &request.source().identifier,
            ))
            .is_some_and(|identity| identity == request.identity())
    }

    /// Explicit aliases never become valid again after response ownership is replaced.
    pub(crate) fn event_key(&self, session: &str, identifier: &str) -> String {
        let key = crate::network_request::request_key(session, identifier);
        if self.latest.contains_key(&key) {
            return key;
        }
        if let Some(request) = self
            .navigation_aliases
            .get(&key)
            .and_then(|identity| self.occurrences.get(identity))
            && self.owns_response(request)
        {
            return crate::network_request::request_key(
                &request.response_session,
                &request.source().identifier,
            );
        }
        key
    }

    fn remove_alias(&mut self, key: &str) {
        if let Some(identity) = self.navigation_aliases.remove(key) {
            let bytes = key.len() + identity.len();
            if let Some(request) = self.occurrences.get_mut(&identity) {
                request.retained_bytes -= bytes;
                self.release(bytes);
            }
        }
    }

    fn header_key(&self, identifier: &str) -> String {
        self.get(identifier).map_or_else(
            || identifier.into(),
            |request| {
                crate::network_request::request_key(
                    &request.source().session,
                    &request.source().identifier,
                )
            },
        )
    }

    /// Only the commit of the unique original logical navigation transfers custody.
    pub(crate) fn committed_navigation(
        &mut self,
        frame: &str,
        loader: &str,
        session: &str,
    ) -> Result<(), ErrorRecord> {
        let candidates: Vec<_> = self
            .latest
            .iter()
            .filter(|(_, identity)| {
                let request = &self.occurrences[*identity];
                !request.finished
                    && request.metadata()["navigation"] == true
                    && request.metadata()["frame"] == frame
                    && request.metadata()["loader"] == loader
                    && request.source().identifier == loader
            })
            .map(|(key, identity)| (key.clone(), identity.clone()))
            .collect();
        let [(old_key, identity)] = candidates.as_slice() else {
            return Ok(());
        };
        let new_key = crate::network_request::request_key(session, loader);
        if old_key == &new_key {
            return Ok(());
        }
        if self.latest.contains_key(&new_key) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                METHOD,
                "navigation response renderer already owns this request identifier",
            ));
        }
        if self.navigation_aliases.len() >= MAXIMUM_COMPLETED_REQUESTS {
            return Err(limited("page exceeds 1024 navigation session aliases"));
        }
        self.remove_alias(old_key);
        let old = self.occurrences[identity].response_session.len();
        let alias_bytes = old_key.len() + identity.len();
        let added = session.len().saturating_sub(old) + alias_bytes;
        self.reserve(added, Some(identity))?;
        let request = self.occurrences.get_mut(identity).unwrap();
        request.response_session = session.into();
        request.awaiting_response_renderer = false;
        request.retained_bytes = request.retained_bytes + added - old.saturating_sub(session.len());
        self.release(old.saturating_sub(session.len()));
        self.latest.remove(old_key);
        self.latest.insert(new_key, identity.clone());
        self.navigation_aliases
            .insert(old_key.clone(), identity.clone());
        Ok(())
    }

    /// Live documents retain their navigation response through completion of large resource loads.
    pub(crate) fn retain_live_loaders(
        &mut self,
        loaders: impl Iterator<Item = String>,
    ) -> Result<(), ErrorRecord> {
        let mut live_loaders = HashSet::new();
        for loader in loaders.filter(|loader| !loader.is_empty()) {
            live_loaders.insert(loader);
            if live_loaders.len() > MAXIMUM_COMPLETED_REQUESTS {
                return Err(limited("page exceeds 1024 live navigation response owners"));
            }
        }
        self.live_loaders = live_loaders;
        while self.completed.len() > MAXIMUM_COMPLETED_REQUESTS && self.evict_completed() {}
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn get_mut(&mut self, identifier: &str) -> Option<&mut RequestState> {
        let identity = self.latest.get(identifier)?;
        self.occurrences.get_mut(identity)
    }

    /// Admit an immutable occurrence without evicting another request that is still in flight.
    pub(crate) fn insert(
        &mut self,
        identifier: String,
        mut request: RequestState,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        if self.occurrences.contains_key(request.identity()) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                METHOD,
                "request occurrence was published twice",
            ));
        }
        self.remove_alias(&identifier);
        // A reused protocol identifier retires its previous owner even if its terminal event was lost.
        if self
            .get(&identifier)
            .is_some_and(|previous| !previous.finished)
        {
            self.finish_record(&identifier, None, true, true, observation)?;
        }
        if self.unfinished >= MAXIMUM_UNFINISHED_REQUESTS {
            return Err(limited("page exceeds 4096 unfinished request occurrences"));
        }
        self.reserve(request.retained_bytes, None)?;
        let identity = request.identity().to_owned();
        observation.emit(NetworkTransition::Created(&request));
        if !request.awaiting_interception {
            request.publicly_ready = true;
            observation.emit(NetworkTransition::Ready(&request));
        }
        self.latest.insert(identifier, identity.clone());
        self.occurrences.insert(identity, request);
        self.unfinished += 1;
        Ok(())
    }

    /// Admit joined Fetch metadata before exposing the request to host callbacks.
    pub(crate) fn publish_request(
        &mut self,
        identifier: &str,
        effective_metadata: Option<Value>,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        let Some(request) = self.get(identifier) else {
            return Ok(());
        };
        if request.publicly_ready {
            return Ok(());
        }
        let identity = request.identity().to_owned();
        let intercepted = effective_metadata.is_some();
        let effective_metadata =
            effective_metadata.filter(|metadata| metadata != request.original_metadata());
        let bytes = effective_metadata.as_ref().map_or(0, encoded_bytes);
        self.reserve(bytes, Some(&identity))?;
        let request = self
            .occurrences
            .get_mut(&identity)
            .expect("latest occurrence retained");
        if let Some(metadata) = effective_metadata {
            let previous_bytes = request.effective_metadata.as_ref().map_or(0, encoded_bytes);
            request.effective_metadata = Some(metadata);
            request.interception_headers = true;
            request.request_headers_ready = true;
            request.retained_bytes = request.retained_bytes + bytes - previous_bytes;
            self.release(previous_bytes);
        }
        let request = self
            .occurrences
            .get_mut(&identity)
            .expect("latest occurrence retained");
        if intercepted {
            request.interception_headers = true;
            request.request_headers_ready = true;
        }
        request.awaiting_interception = false;
        request.publicly_ready = true;
        observation.emit(NetworkTransition::Ready(request));
        Ok(())
    }

    pub(crate) fn publish_pending(
        &mut self,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        let mut pending: Vec<_> = self
            .latest
            .iter()
            .filter(|(_, identity)| {
                self.occurrences
                    .get(*identity)
                    .is_some_and(|request| !request.publicly_ready)
            })
            .map(|(identifier, identity)| {
                (
                    self.occurrences[identity].ingress().sequence,
                    identifier.clone(),
                )
            })
            .collect();
        pending.sort_by_key(|(sequence, _)| *sequence);
        for (_, identifier) in pending {
            self.publish_request(&identifier, None, observation)?;
        }
        Ok(())
    }

    /// A cached occurrence resolves headers without waiting for extra-info that will not arrive.
    pub(crate) fn served_from_cache(
        &mut self,
        identifier: &str,
        observation: &mut NetworkObservation<'_, '_>,
    ) {
        if let Some(identity) = self.latest.get(identifier)
            && let Some(request) = self.occurrences.get_mut(identity)
        {
            request.served_from_cache = true;
            observation.emit(NetworkTransition::Cached(request));
        }
    }

    /// Bind response metadata and each extra-info target before a redirect replaces the latest index.
    pub(crate) fn respond(
        &mut self,
        identifier: &str,
        response: Value,
        has_extra_info: bool,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        self.publish_request(identifier, None, observation)?;
        let Some(identity) = self.latest.get(identifier).cloned() else {
            return Ok(());
        };
        let request = self
            .occurrences
            .get(&identity)
            .expect("latest occurrence is retained");
        let header_key = self.header_key(identifier);
        let first_response = request.response.is_none();
        let needs_headers = first_response && has_extra_info && !request.served_from_cache;
        if needs_headers {
            let chain = self.header_chains.get(&header_key);
            let paired = chain.map_or(0, |chain| {
                usize::from(!chain.requests.is_empty()) + usize::from(!chain.responses.is_empty())
            });
            self.admit_headers(&header_key, 2, paired)?;
        }
        let bytes = encoded_bytes(&response);
        self.reserve(bytes, Some(&identity))?;
        let request = self
            .occurrences
            .get_mut(&identity)
            .expect("latest occurrence is retained");
        let previous_bytes = request.response.as_ref().map_or(0, encoded_bytes);
        request.response = Some(response);
        request.retained_bytes = request.retained_bytes + bytes - previous_bytes;
        if first_response && !needs_headers {
            request.request_headers_ready = true;
            request.response_headers_ready = true;
        }
        self.release(previous_bytes);
        if needs_headers {
            let chain = self.header_chains.entry(header_key.clone()).or_default();
            chain.request_targets.push_back(identity.clone());
            chain.response_targets.push_back(identity.clone());
            self.header_records += 2;
            self.pair_headers(&header_key, observation);
            self.check_header_limit()?;
        }
        observation.emit(NetworkTransition::Responded(
            self.occurrences
                .get(&identity)
                .expect("observed response is retained"),
        ));
        Ok(())
    }

    /// Redirect completion retains the predecessor; terminal completion additionally closes pairing.
    pub(crate) fn finish(
        &mut self,
        identifier: &str,
        failure: Option<String>,
        terminal: bool,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        self.finish_record(identifier, failure, terminal, false, observation)
    }

    fn finish_record(
        &mut self,
        identifier: &str,
        failure: Option<String>,
        terminal: bool,
        retired: bool,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        let header_key = self.header_key(identifier);
        if !retired {
            self.publish_request(identifier, None, observation)?;
        }
        if let Some(identity) = self.latest.get(identifier).cloned() {
            let bytes = failure.as_ref().map_or(0, encoded_bytes);
            self.reserve(bytes, Some(&identity))?;
            let request = self
                .occurrences
                .get_mut(&identity)
                .expect("latest occurrence is retained");
            if !request.finished {
                request.finished = true;
                request.awaiting_response_renderer = false;
                self.unfinished -= 1;
                self.completed.push_back(identity.clone());
            }
            let previous_bytes = request.failure.as_ref().map_or(0, encoded_bytes);
            request.failure = failure;
            request.redirecting = !terminal && !retired;
            request.retained_bytes = request.retained_bytes + bytes - previous_bytes;
            if request.response.is_none() {
                request.request_headers_ready = true;
                request.response_headers_ready = true;
            }
            self.release(previous_bytes);
        }
        if terminal && let Some(chain) = self.header_chains.get_mut(&header_key) {
            chain.finished = true;
            self.pair_headers(&header_key, observation);
        }
        if let Some(request) = self.get(identifier) {
            observation.emit(if retired {
                NetworkTransition::Retired(request)
            } else {
                NetworkTransition::Completed(request)
            });
        }
        while self.completed.len() > MAXIMUM_COMPLETED_REQUESTS && self.evict_completed() {}
        Ok(())
    }

    /// Extra-info may precede request or response metadata, but can never select a successor by ID alone.
    pub(crate) fn extra_headers(
        &mut self,
        identifier: &str,
        headers: Value,
        kind: HeaderKind,
        observation: &mut NetworkObservation<'_, '_>,
    ) -> Result<(), ErrorRecord> {
        let header_key = self.header_key(identifier);
        if !self.header_chains.contains_key(&header_key)
            && self.get(identifier).is_some_and(|request| request.finished)
        {
            return Ok(());
        }
        let paired = self
            .header_chains
            .get(&header_key)
            .is_some_and(|chain| match kind {
                HeaderKind::Request => !chain.request_targets.is_empty(),
                HeaderKind::Response => !chain.response_targets.is_empty(),
            });
        self.admit_headers(&header_key, 1, usize::from(paired))?;
        let bytes = encoded_bytes(&headers);
        self.reserve(bytes, None)?;
        observation.emit(NetworkTransition::ExtraInfo { identifier, kind });
        let chain = self.header_chains.entry(header_key.clone()).or_default();
        let records = match kind {
            HeaderKind::Request => &mut chain.requests,
            HeaderKind::Response => &mut chain.responses,
        };
        records.push_back(HeaderRecord {
            headers,
            ingress: observation.event.ingress,
            bytes,
        });
        self.header_records += 1;
        self.pair_headers(&header_key, observation);
        self.check_header_limit()
    }

    /// Header reads address retained occurrences, including redirect predecessors, independently of body access.
    pub(crate) fn headers(
        &self,
        identity: &str,
        kind: HeaderKind,
    ) -> Result<Option<Value>, ErrorRecord> {
        let request = self.occurrences.get(identity).ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::ResourceLimit,
                "network.headers",
                "request is outside the bounded retained network history",
            )
        })?;
        let (ready, raw, provisional) = match kind {
            HeaderKind::Request => (
                request.request_headers_ready,
                request.raw_request_headers.as_ref(),
                &request.metadata()["headers"],
            ),
            HeaderKind::Response => (
                request.response_headers_ready,
                request.raw_response_headers.as_ref(),
                request
                    .response
                    .as_ref()
                    .map_or(&Value::Null, |response| &response["headers"]),
            ),
        };
        Ok(ready.then(|| header_array(raw.unwrap_or(provisional))))
    }

    /// Retirement settles semantic waits; it is not a synthetic browser response.
    pub(crate) fn renderer_detached(
        &mut self,
        session: &str,
        observation: &mut NetworkObservation<'_, '_>,
        can_transfer: impl Fn(&RequestState) -> bool,
    ) -> Result<(), ErrorRecord> {
        let prefix = crate::network_request::request_key(session, "");
        let keys: Vec<_> = self
            .header_chains
            .keys()
            .filter(|key| {
                key.starts_with(&prefix)
                    || self.header_chains[*key]
                        .request_targets
                        .iter()
                        .chain(&self.header_chains[*key].response_targets)
                        .any(|identity| {
                            self.occurrences
                                .get(identity)
                                .is_some_and(|request| request.response_session == session)
                        })
            })
            .cloned()
            .collect();
        for key in keys {
            let identities: HashSet<_> = self.header_chains[&key]
                .request_targets
                .iter()
                .chain(&self.header_chains[&key].response_targets)
                .cloned()
                .collect();
            for identity in identities {
                if let Some(request) = self.occurrences.get_mut(&identity) {
                    request.request_headers_ready = true;
                    request.response_headers_ready = true;
                }
                observation.emit(NetworkTransition::HeadersUnavailable(&identity));
            }
            self.forget_headers(&key, observation);
        }
        let pending: Vec<_> = self
            .latest
            .iter()
            .filter(|(_, identity)| {
                let request = &self.occurrences[*identity];
                request.response_session == session && !request.finished
            })
            .map(|(key, identity)| (self.occurrences[identity].ingress().sequence, key.clone()))
            .collect();
        let mut pending = pending;
        pending.sort_by_key(|(sequence, _)| *sequence);
        self.live_loaders.retain(|key| !key.starts_with(&prefix));
        for (_, key) in pending {
            let identity = self.latest[&key].clone();
            let request = self.occurrences.get_mut(&identity).unwrap();
            if request.metadata()["navigation"] == true && can_transfer(request) {
                request.awaiting_response_renderer = true;
                continue;
            }
            self.finish(
                &key,
                Some("original request renderer detached".into()),
                true,
                observation,
            )?;
        }
        Ok(())
    }

    /// A transfer wait belongs to one pending logical navigation, never a later frame incarnation.
    pub(crate) fn retire_orphaned_transfers(
        &mut self,
        observation: &mut NetworkObservation<'_, '_>,
        still_pending: impl Fn(&RequestState) -> bool,
    ) -> Result<(), ErrorRecord> {
        let orphaned: Vec<_> = self
            .latest
            .iter()
            .filter(|(_, identity)| {
                let request = &self.occurrences[*identity];
                request.awaiting_response_renderer && !still_pending(request)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in orphaned {
            self.finish(
                &key,
                Some("original navigation frame retired before renderer commit".into()),
                true,
                observation,
            )?;
        }
        Ok(())
    }

    /// Ignore excluded requests without keeping orphan extra-info records alive until page teardown.
    pub(crate) fn forget_headers(
        &mut self,
        identifier: &str,
        observation: &mut NetworkObservation<'_, '_>,
    ) {
        if let Some(chain) = self.header_chains.remove(identifier) {
            Self::discard_extra(&chain, observation);
            self.header_records -= chain.requests.len()
                + chain.responses.len()
                + chain.request_targets.len()
                + chain.response_targets.len();
            self.release(
                chain
                    .requests
                    .iter()
                    .chain(&chain.responses)
                    .map(|record| record.bytes)
                    .sum(),
            );
        }
    }

    /// Transfer queued header ownership into the exact target, or release it after explicit history expiry.
    fn pair_headers(&mut self, identifier: &str, observation: &mut NetworkObservation<'_, '_>) {
        let Some(mut chain) = self.header_chains.remove(identifier) else {
            return;
        };
        for (kind, targets, records) in [
            (
                HeaderKind::Request,
                &mut chain.request_targets,
                &mut chain.requests,
            ),
            (
                HeaderKind::Response,
                &mut chain.response_targets,
                &mut chain.responses,
            ),
        ] {
            while !targets.is_empty() && !records.is_empty() {
                let identity = targets.pop_front().unwrap();
                let record = records.pop_front().unwrap();
                self.header_records -= 2;
                // Recorder history owns this identity independently of public occurrence retention.
                observation.emit(NetworkTransition::Headers {
                    identity: &identity,
                    kind,
                    headers: &record.headers,
                    ingress: record.ingress,
                });
                if let Some(request) = self.occurrences.get_mut(&identity) {
                    if matches!(kind, HeaderKind::Request) && request.interception_headers {
                        self.release(record.bytes);
                        continue;
                    }
                    let (raw, ready) = match kind {
                        HeaderKind::Request => (
                            &mut request.raw_request_headers,
                            &mut request.request_headers_ready,
                        ),
                        HeaderKind::Response => (
                            &mut request.raw_response_headers,
                            &mut request.response_headers_ready,
                        ),
                    };
                    let previous_bytes = raw.as_ref().map_or(0, encoded_bytes);
                    *raw = Some(record.headers);
                    *ready = true;
                    request.retained_bytes = request.retained_bytes + record.bytes - previous_bytes;
                    self.release(previous_bytes);
                } else {
                    self.release(record.bytes);
                }
            }
        }
        if chain.finished && chain.request_targets.is_empty() && chain.response_targets.is_empty() {
            Self::discard_extra(&chain, observation);
            self.header_records -= chain.requests.len() + chain.responses.len();
            self.release(
                chain
                    .requests
                    .iter()
                    .chain(&chain.responses)
                    .map(|record| record.bytes)
                    .sum(),
            );
        } else {
            self.header_chains.insert(identifier.to_owned(), chain);
        }
    }

    fn discard_extra(chain: &HeaderChain, observation: &mut NetworkObservation<'_, '_>) {
        for (kind, records) in [
            (HeaderKind::Request, &chain.requests),
            (HeaderKind::Response, &chain.responses),
        ] {
            for record in records {
                observation.emit(NetworkTransition::DiscardedExtra {
                    kind,
                    ingress: record.ingress,
                });
            }
        }
    }

    fn check_header_limit(&self) -> Result<(), ErrorRecord> {
        if self.header_records > MAXIMUM_HEADER_RECORDS
            || self.header_chains.len() > MAXIMUM_HEADER_RECORDS
        {
            Err(limited(
                "page exceeds 4096 unmatched network header records",
            ))
        } else {
            Ok(())
        }
    }

    fn admit_headers(
        &self,
        identifier: &str,
        added: usize,
        paired: usize,
    ) -> Result<(), ErrorRecord> {
        if self.header_records + added > MAXIMUM_HEADER_RECORDS + 2 * paired
            || (!self.header_chains.contains_key(identifier)
                && self.header_chains.len() >= MAXIMUM_HEADER_RECORDS)
        {
            return Err(limited(
                "page exceeds 4096 unmatched network header records",
            ));
        }
        Ok(())
    }

    /// Completed history yields to new observations; active records retain their admission credits.
    fn reserve(
        &mut self,
        bytes: usize,
        protected_identity: Option<&str>,
    ) -> Result<(), ErrorRecord> {
        loop {
            let retained = self
                .reservation
                .as_ref()
                .map_or(0, OwnedSemaphorePermit::num_permits);
            if retained.saturating_add(bytes) <= PAGE_NETWORK_BYTES
                && let Ok(additional) = self.budget.clone().try_acquire_many_owned(bytes as u32)
            {
                if let Some(reservation) = self.reservation.as_mut() {
                    reservation.merge(additional);
                } else {
                    self.reservation = Some(additional);
                }
                return Ok(());
            }
            if !self.evict_completed_except(protected_identity) {
                return Err(limited(
                    "retained network metadata exceeds 64 MiB per page or 256 MiB per engine",
                ));
            }
        }
    }

    fn release(&mut self, bytes: usize) {
        if bytes != 0 {
            drop(
                self.reservation
                    .as_mut()
                    .expect("retained network bytes have a reservation")
                    .split(bytes)
                    .expect("released network bytes were admitted"),
            );
        }
    }

    fn evict_completed(&mut self) -> bool {
        self.evict_completed_except(None)
    }

    fn evict_completed_except(&mut self, protected_identity: Option<&str>) -> bool {
        let Some(index) = self.completed.iter().position(|identity| {
            Some(identity.as_str()) != protected_identity
                && !self.occurrences.get(identity).is_some_and(|request| {
                    request.metadata()["navigation"] == true
                        && self.owns_response(request)
                        && request.metadata()["loader"].as_str().is_some_and(|loader| {
                            self.live_loaders
                                .contains(&crate::network_request::request_key(
                                    &request.response_session,
                                    loader,
                                ))
                        })
                })
        }) else {
            return false;
        };
        let identity = self.completed.remove(index).unwrap();
        if let Some(request) = self.occurrences.remove(&identity) {
            let identifier = crate::network_request::request_key(
                &request.response_session,
                &request.source().identifier,
            );
            if self.latest.get(&identifier) == Some(&identity) {
                self.latest.remove(&identifier);
            }
            self.navigation_aliases
                .retain(|_, owner| owner != &identity);
            self.release(request.retained_bytes);
        }
        true
    }
}

/// Count retained JSON without allocating a second encoded payload.
pub(crate) fn encoded_bytes(value: &impl serde::Serialize) -> usize {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).expect("JSON values serialize");
    counter.0
}

/// Chromium combines repeated raw header values with newlines and preserves field-name casing.
fn header_array(headers: &Value) -> Value {
    let mut entries = Vec::new();
    if let Some(headers) = headers.as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                for value in value.split('\n') {
                    entries.push(json!({"name":name,"value":value}));
                }
            }
        }
    }
    Value::Array(entries)
}

fn limited(message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, METHOD, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(identifier: &str, sequence: u64) -> RequestState {
        RequestState::new(
            identifier,
            sequence,
            &json!({
                "requestId":identifier, "loaderId":"", "type":"Fetch",
                "request":{"url":"https://example.test/", "method":"GET", "headers":{"Provisional":"request"}}
            }),
        )
    }

    fn response() -> Value {
        json!({"status":200, "headers":{"Provisional":"response"}})
    }

    fn value(requests: &NetworkRequests, identity: &str, kind: HeaderKind) -> Value {
        requests.headers(identity, kind).unwrap().unwrap()
    }

    fn scoped_request(
        session: &str,
        native: &str,
        sequence: u64,
        navigation: bool,
    ) -> RequestState {
        let parameters = json!({"requestId":native,"loaderId":native,"frameId":"child-frame",
            "type":if navigation {"Document"} else {"Fetch"},
            "request":{"url":"https://example.test/", "method":"GET","headers":{}}});
        RequestState::from_event(
            &crate::network_request::request_key(session, native),
            sequence,
            &crate::network_observer::NetworkEvent {
                session_identifier: session,
                method: "Network.requestWillBeSent",
                parameters: &parameters,
                ingress: crate::network_observer::NetworkIngress {
                    sequence,
                    received_at: std::time::Instant::now(),
                },
            },
            None,
        )
    }

    #[test]
    fn detached_navigation_waits_for_exact_commit_or_logical_frame_retirement() {
        for commit in [true, false] {
            let mut requests = NetworkRequests::default();
            requests
                .insert(
                    "5:childNAV".into(),
                    scoped_request("child", "NAV", 1, true),
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .renderer_detached("child", &mut NetworkObservation::ignored(), |_| true)
                .unwrap();
            assert!(
                requests
                    .get("5:childNAV")
                    .unwrap()
                    .awaiting_response_renderer
            );
            assert_eq!(requests.unfinished, 1);
            if commit {
                requests
                    .committed_navigation("child-frame", "NAV", "parent")
                    .unwrap();
                let request = requests.get("6:parentNAV").unwrap();
                assert!(!request.awaiting_response_renderer);
                assert!(!request.finished);
                assert_eq!(request.source().session, "child");
            } else {
                requests
                    .retire_orphaned_transfers(&mut NetworkObservation::ignored(), |_| false)
                    .unwrap();
                let request = requests.get("5:childNAV").unwrap();
                assert!(!request.awaiting_response_renderer);
                assert!(request.finished && request.failure.is_some());
                assert_eq!(requests.unfinished, 0);
            }
        }
    }

    #[test]
    fn renderer_request_ids_and_header_queues_are_independent() {
        let mut requests = NetworkRequests::default();
        for (index, session) in ["parent", "child"].into_iter().enumerate() {
            let key = crate::network_request::request_key(session, "7.1");
            requests
                .extra_headers(
                    &key,
                    json!({"Owner":session}),
                    HeaderKind::Response,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .insert(
                    key.clone(),
                    scoped_request(session, "7.1", index as u64, false),
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .respond(&key, response(), true, &mut NetworkObservation::ignored())
                .unwrap();
        }
        requests
            .renderer_detached("child", &mut NetworkObservation::ignored(), |_| false)
            .unwrap();
        let parent = requests.get("6:parent7.1").unwrap();
        assert!(!parent.finished);
        assert_eq!(
            parent.raw_response_headers.as_ref().unwrap()["Owner"],
            "parent"
        );
        let child = requests.get("5:child7.1").unwrap();
        assert!(child.finished && child.failure.is_some());
        assert!(child.request_headers_ready && child.response_headers_ready);
        assert_eq!(
            child.raw_response_headers.as_ref().unwrap()["Owner"],
            "child"
        );
        assert_eq!(requests.unfinished, 1);
        assert_eq!(requests.header_records, 1);
        requests
            .renderer_detached("parent", &mut NetworkObservation::ignored(), |_| false)
            .unwrap();
        assert_eq!(requests.unfinished, 0);
        assert_eq!(requests.header_records, 0);
    }

    #[test]
    fn navigation_transfer_preserves_original_identity_and_parent_header_source() {
        let mut requests = NetworkRequests::default();
        let request = scoped_request("parent", "NAV", 1, true);
        let identity = request.identity().to_owned();
        requests
            .insert(
                "6:parentNAV".into(),
                request,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .respond(
                "6:parentNAV",
                response(),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .committed_navigation("wrong-frame", "NAV", "child")
            .unwrap();
        assert!(requests.get("5:childNAV").is_none());
        requests
            .committed_navigation("child-frame", "NAV", "child")
            .unwrap();
        assert_eq!(requests.event_key("parent", "NAV"), "5:childNAV");
        let request = requests.get("5:childNAV").unwrap();
        assert_eq!(request.identity(), identity);
        assert_eq!(request.source().session, "parent");
        assert_eq!(request.response_source().session, "child");
        requests
            .extra_headers(
                "5:childNAV",
                json!({"Late":"original-parent"}),
                HeaderKind::Response,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        assert_eq!(
            requests
                .get("5:childNAV")
                .unwrap()
                .raw_response_headers
                .as_ref()
                .unwrap()["Late"],
            "original-parent"
        );
        requests
            .renderer_detached("parent", &mut NetworkObservation::ignored(), |_| false)
            .unwrap();
        assert!(!requests.get("5:childNAV").unwrap().finished);
        assert_eq!(requests.header_records, 0);
        requests
            .renderer_detached("child", &mut NetworkObservation::ignored(), |_| false)
            .unwrap();
        assert_eq!(requests.unfinished, 0);
        assert!(requests.get("5:childNAV").unwrap().failure.is_some());
    }

    #[test]
    fn renderer_churn_reclaims_unfinished_requests_and_orphan_headers() {
        let mut requests = NetworkRequests::default();
        for index in 0..4200 {
            let session = format!("child-{index}");
            let key = crate::network_request::request_key(&session, "7.1");
            requests
                .insert(
                    key.clone(),
                    scoped_request(&session, "7.1", index, false),
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .respond(&key, response(), true, &mut NetworkObservation::ignored())
                .unwrap();
            requests
                .extra_headers(
                    &crate::network_request::request_key(&session, "orphan"),
                    json!({"Orphan":"x"}),
                    HeaderKind::Request,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .renderer_detached(&session, &mut NetworkObservation::ignored(), |_| false)
                .unwrap();
            assert_eq!(requests.unfinished, 0);
            assert_eq!(requests.header_records, 0);
            assert!(requests.header_chains.is_empty());
        }
        assert!(requests.occurrences.len() <= MAXIMUM_COMPLETED_REQUESTS);
    }

    #[test]
    fn redirect_headers_pair_by_occurrence_in_both_event_orders() {
        let mut requests = NetworkRequests::default();
        requests
            .insert(
                "shared".into(),
                request("shared", 1),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .respond(
                "shared",
                response(),
                false,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("shared", None, false, &mut NetworkObservation::ignored())
            .unwrap();
        requests
            .insert(
                "shared".into(),
                request("shared", 2),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .extra_headers(
                "shared",
                json!({"Hop":"second request"}),
                HeaderKind::Request,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .extra_headers(
                "shared",
                json!({"Hop":"second response"}),
                HeaderKind::Response,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .respond(
                "shared",
                response(),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("shared", None, false, &mut NetworkObservation::ignored())
            .unwrap();
        requests
            .insert(
                "shared".into(),
                request("shared", 3),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .respond(
                "shared",
                response(),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("shared", None, true, &mut NetworkObservation::ignored())
            .unwrap();
        assert!(
            requests
                .headers("shared:3", HeaderKind::Response)
                .unwrap()
                .is_none()
        );
        requests
            .extra_headers(
                "shared",
                json!({"Hop":"third response"}),
                HeaderKind::Response,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .extra_headers(
                "shared",
                json!({"Hop":"third request"}),
                HeaderKind::Request,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        for (identity, expected_request, expected_response) in [
            ("shared:1", "request", "response"),
            ("shared:2", "second request", "second response"),
            ("shared:3", "third request", "third response"),
        ] {
            assert_eq!(
                value(&requests, identity, HeaderKind::Request)[0]["value"],
                expected_request
            );
            assert_eq!(
                value(&requests, identity, HeaderKind::Response)[0]["value"],
                expected_response
            );
        }
        assert_eq!(requests.get("shared").unwrap().identity(), "shared:3");
        assert_eq!(requests.unfinished, 0);
        assert_eq!(requests.header_records, 0);
        assert!(requests.header_chains.is_empty());
    }

    #[test]
    fn failed_and_cached_requests_resolve_without_missing_extra_info() {
        let mut requests = NetworkRequests::default();
        requests
            .insert(
                "failed".into(),
                request("failed", 1),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .extra_headers(
                "failed",
                json!({"ignored":"unpaired"}),
                HeaderKind::Request,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish(
                "failed",
                Some("net::ERR_FAILED".into()),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        assert_eq!(
            value(&requests, "failed:1", HeaderKind::Request),
            json!([{"name":"Provisional","value":"request"}])
        );
        assert!(requests.header_chains.is_empty());
        requests
            .insert(
                "cached".into(),
                request("cached", 2),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests.served_from_cache("cached", &mut NetworkObservation::ignored());
        requests
            .respond(
                "cached",
                response(),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("cached", None, true, &mut NetworkObservation::ignored())
            .unwrap();
        assert_eq!(
            value(&requests, "cached:2", HeaderKind::Response),
            json!([{"name":"Provisional","value":"response"}])
        );
        assert_eq!(requests.header_records, 0);
    }

    #[test]
    fn late_headers_for_expired_predecessor_cannot_replace_successor_headers() {
        let budget = Arc::new(Semaphore::new(4096));
        let mut requests = NetworkRequests::new(budget.clone());
        requests
            .insert(
                "shared".into(),
                request("shared", 1),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .respond(
                "shared",
                response(),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("shared", None, false, &mut NetworkObservation::ignored())
            .unwrap();
        requests
            .insert(
                "shared".into(),
                request("shared", 2),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        assert!(requests.evict_completed());
        requests
            .respond(
                "shared",
                response(),
                true,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        for kind in [HeaderKind::Request, HeaderKind::Response] {
            requests
                .extra_headers(
                    "shared",
                    json!({"Hop":"expired"}),
                    kind,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            assert!(requests.headers("shared:2", kind).unwrap().is_none());
            requests
                .extra_headers(
                    "shared",
                    json!({"Hop":"successor"}),
                    kind,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            assert_eq!(value(&requests, "shared:2", kind)[0]["value"], "successor");
        }
        requests
            .finish("shared", None, true, &mut NetworkObservation::ignored())
            .unwrap();
        assert!(requests.headers("shared:1", HeaderKind::Request).is_err());
        assert_eq!(requests.header_records, 0);
        let retained = requests.get("shared").unwrap().retained_bytes;
        assert_eq!(budget.available_permits(), 4096 - retained);
    }

    #[test]
    fn reused_identifier_retires_unfinished_owner_without_losing_its_metadata() {
        let mut requests = NetworkRequests::default();
        requests
            .insert(
                "shared".into(),
                request("shared", 1),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .insert(
                "shared".into(),
                request("shared", 2),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        assert_eq!(requests.unfinished, 1);
        assert_eq!(requests.completed.len(), 1);
        assert!(requests.occurrences["shared:1"].finished);
        assert_eq!(requests.get("shared").unwrap().identity(), "shared:2");
        assert_eq!(
            value(&requests, "shared:1", HeaderKind::Request)[0]["value"],
            "request"
        );
    }

    #[test]
    fn raw_fields_preserve_case_empty_and_repeated_values() {
        assert_eq!(
            header_array(&json!({"Set-Cookie":"one=1\ntwo=2", "X-Empty":"", "x-Other":"one\ntwo"})),
            json!([
                {"name":"Set-Cookie","value":"one=1"}, {"name":"Set-Cookie","value":"two=2"},
                {"name":"X-Empty","value":""}, {"name":"x-Other","value":"one"}, {"name":"x-Other","value":"two"}
            ])
        );
    }

    #[test]
    fn completed_history_keeps_active_requests_and_live_navigation_owners() {
        let mut requests = NetworkRequests::default();
        requests
            .insert(
                "active".into(),
                request("active", 1),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        let navigation = RequestState::new(
            "document",
            2,
            &json!({"requestId":"document","loaderId":"document","type":"Document","request":{"url":"https://example.test/", "headers":{}}}),
        );
        requests
            .insert(
                "document".into(),
                navigation,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .retain_live_loaders(["document".to_owned()].into_iter())
            .unwrap();
        requests
            .respond(
                "document",
                response(),
                false,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("document", None, true, &mut NetworkObservation::ignored())
            .unwrap();
        for sequence in 3..1030 {
            let identifier = format!("request-{sequence}");
            requests
                .insert(
                    identifier.clone(),
                    request(&identifier, sequence),
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .finish(&identifier, None, true, &mut NetworkObservation::ignored())
                .unwrap();
        }
        assert_eq!(requests.completed.len(), MAXIMUM_COMPLETED_REQUESTS);
        assert_eq!(requests.occurrences.len(), MAXIMUM_COMPLETED_REQUESTS + 1);
        assert!(requests.get("active").is_some());
        assert!(requests.get("document").unwrap().response.is_some());
        assert!(
            requests
                .headers("request-3:3", HeaderKind::Request)
                .is_err()
        );
        requests.retain_live_loaders(std::iter::empty()).unwrap();
        assert!(requests.evict_completed());
        assert!(requests.get("document").is_none());
    }

    #[test]
    fn retained_and_queued_bytes_share_credit_and_release_on_drop() {
        let budget = Arc::new(Semaphore::new(4096));
        {
            let mut requests = NetworkRequests::new(budget.clone());
            requests
                .insert(
                    "request".into(),
                    request("request", 1),
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .extra_headers(
                    "request",
                    json!({"raw":"request"}),
                    HeaderKind::Request,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .extra_headers(
                    "request",
                    json!({"raw":"response"}),
                    HeaderKind::Response,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .respond(
                    "request",
                    response(),
                    true,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            requests
                .finish(
                    "request",
                    Some("failure \"with escaping\"".into()),
                    true,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            let state = requests.get("request").unwrap();
            let expected = state.source().session.len()
                + state.response_session.len()
                + state.source().identifier.len()
                + encoded_bytes(state.metadata())
                + encoded_bytes(state.response.as_ref().unwrap())
                + encoded_bytes(state.raw_request_headers.as_ref().unwrap())
                + encoded_bytes(state.raw_response_headers.as_ref().unwrap())
                + encoded_bytes(state.failure.as_ref().unwrap());
            assert_eq!(state.retained_bytes, expected);
            assert_eq!(budget.available_permits(), 4096 - expected);
            requests
                .extra_headers(
                    "orphan",
                    json!({"large":"x".repeat(128)}),
                    HeaderKind::Request,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
            assert!(budget.available_permits() < 4096 - expected);
            requests.forget_headers("orphan", &mut NetworkObservation::ignored());
            assert_eq!(budget.available_permits(), 4096 - expected);
        }
        assert_eq!(budget.available_permits(), 4096);
    }

    #[test]
    fn budget_pressure_expires_completed_records_but_never_the_observed_owner() {
        let budget = Arc::new(Semaphore::new(2048));
        let mut requests = NetworkRequests::new(budget.clone());
        requests
            .insert(
                "finished".into(),
                request("finished", 1),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        requests
            .finish("finished", None, true, &mut NetworkObservation::ignored())
            .unwrap();
        requests
            .insert(
                "active".into(),
                request("active", 2),
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        let other_page = budget
            .clone()
            .try_acquire_many_owned(budget.available_permits() as u32)
            .unwrap();
        requests
            .respond(
                "active",
                response(),
                false,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        assert!(requests.get("finished").is_none());
        assert!(requests.get("active").is_some());
        let error = requests
            .extra_headers(
                "active",
                json!({"large":"x".repeat(2048)}),
                HeaderKind::Request,
                &mut NetworkObservation::ignored(),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        assert!(requests.get("active").is_some());
        drop(other_page);
        requests
            .finish("active", None, true, &mut NetworkObservation::ignored())
            .unwrap();
        requests
            .respond(
                "active",
                response(),
                false,
                &mut NetworkObservation::ignored(),
            )
            .unwrap();
        assert!(requests.get("active").is_some());
    }

    #[test]
    fn active_and_unmatched_header_admission_are_bounded() {
        let mut requests = NetworkRequests::default();
        for sequence in 0..MAXIMUM_UNFINISHED_REQUESTS {
            let identifier = sequence.to_string();
            requests
                .insert(
                    identifier.clone(),
                    request(&identifier, sequence as u64),
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
        }
        assert_eq!(
            requests
                .insert(
                    "overflow".into(),
                    request("overflow", 4096),
                    &mut NetworkObservation::ignored()
                )
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert!(requests.get("0").is_some());
        let mut requests = NetworkRequests::default();
        for _ in 0..MAXIMUM_HEADER_RECORDS {
            requests
                .extra_headers(
                    "unmatched",
                    json!({}),
                    HeaderKind::Request,
                    &mut NetworkObservation::ignored(),
                )
                .unwrap();
        }
        assert_eq!(
            requests
                .extra_headers(
                    "unmatched",
                    json!({}),
                    HeaderKind::Request,
                    &mut NetworkObservation::ignored()
                )
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
    }
}
