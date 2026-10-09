//! Raw header reads wait for their original occurrence, including retained redirect predecessors.

use super::*;
use crate::network_state::HeaderKind;

impl Engine {
    /// Header observation does not dispatch another HTTP request or reuse a successor's identity.
    pub(crate) async fn network_headers(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let method = "network.headers";
        validate_keys(method, &parameters, &["page", "requestIdentity", "kind"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let identity = identifier(&parameters, "requestIdentity", method)?;
        let kind = match identifier(&parameters, "kind", method)? {
            "request" => HeaderKind::Request,
            "response" => HeaderKind::Response,
            _ => {
                return Err(ErrorRecord::new(
                    ErrorCode::InvalidArgument,
                    method,
                    "header kind must be request or response",
                ));
            }
        };
        let mut changes = page.state.changed.subscribe();
        loop {
            operation.check()?;
            {
                let state = page.state.state.lock().unwrap();
                state.check(method)?;
                if let Some(headers) = state.requests.headers(identity, kind)? {
                    return Ok(headers);
                }
            }
            operation
                .wait(async { changes.changed().await.map_err(|_| closed(method)) })
                .await?;
        }
    }
}
