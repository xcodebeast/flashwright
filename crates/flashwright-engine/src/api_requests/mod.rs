//! Native standalone API request ownership and transport.

mod allocation;
mod budget;
mod certificate_key;
mod connection_custody;
mod connector;
mod cookie_date;
mod cookie_date_parser;
mod cookie_jar;
mod exchange;
mod fetch;
mod local_dates;
mod options;
mod registry;
mod resolver;
mod response_decoder;
mod tls;
mod transport_error;

pub(crate) use registry::RequestRegistry;
pub use registry::RetainedValue;

use super::{Engine, Operation, OperationResult, identifier, validate_keys};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use serde_json::{Value, json};

fn unix_milliseconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

impl Engine {
    pub(crate) async fn api_response_body(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<flashwright_protocol::BinaryAttachment, ErrorRecord> {
        let method = "apiResponse.body";
        validate_keys(method, &parameters, &["context", "response"])?;
        let context = self
            .api_requests
            .context(identifier(&parameters, "context", method)?, method)?;
        let response = context.response(identifier(&parameters, "response", method)?, method)?;
        let reservation = operation
            .wait(context.while_response_alive(&response, method, async {
                self.attachment_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| {
                        ErrorRecord::new(
                            ErrorCode::TargetClosed,
                            method,
                            "attachment output is closed",
                        )
                    })
            }))
            .await?;
        operation.check()?;
        flashwright_protocol::BinaryAttachment::from_shared_raw(
            response.body.bytes.clone(),
            response.clone(),
            self.maximum_attachment_bytes,
            reservation,
            method,
        )
    }

    pub(crate) fn api_request_control(
        &self,
        method: &str,
        parameters: Value,
        operation: &Operation,
    ) -> Result<OperationResult, ErrorRecord> {
        operation.check()?;
        match method {
            "apiRequest.newContext" => {
                let options = options::ContextOptions::parse(parameters)?;
                let context = self
                    .api_requests
                    .create(self.identifier("api-context"), options)?;
                if let Err(error) = operation.check() {
                    self.api_requests.dispose_context(&context.identifier);
                    return Err(error);
                }
                Ok(OperationResult::Value(
                    json!({ "identifier": context.identifier }),
                ))
            }
            "apiRequest.storageState" => {
                validate_keys(method, &parameters, &["context"])?;
                let context = self
                    .api_requests
                    .context(identifier(&parameters, "context", method)?, method)?;
                let snapshot = context.storage_snapshot()?;
                operation.check()?;
                Ok(OperationResult::RetainedValue(snapshot))
            }
            "apiRequest.dispose" => {
                validate_keys(method, &parameters, &["context", "reason"])?;
                if parameters
                    .get("reason")
                    .is_some_and(|reason| !reason.is_string())
                {
                    return Err(ErrorRecord::new(
                        ErrorCode::InvalidArgument,
                        method,
                        "reason must be a string",
                    ));
                }
                self.api_requests
                    .dispose_context(identifier(&parameters, "context", method)?);
                Ok(OperationResult::Value(Value::Null))
            }
            "apiResponse.dispose" => {
                validate_keys(method, &parameters, &["context", "response"])?;
                self.api_requests.dispose_response(
                    identifier(&parameters, "context", method)?,
                    identifier(&parameters, "response", method)?,
                );
                Ok(OperationResult::Value(Value::Null))
            }
            _ => Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                method,
                "native API request operation is not integrated",
            )),
        }
    }
}
