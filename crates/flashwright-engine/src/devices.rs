use flashwright_protocol::ErrorRecord;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Viewport, invalid, parse};

#[derive(Clone)]
pub(crate) struct DeviceOptions {
    pub screen: Option<Viewport>,
    pub device_scale_factor: f64,
    pub is_mobile: bool,
    pub has_touch: bool,
    pub user_agent: String,
    pub user_agent_metadata: Option<UserAgentMetadata>,
}

impl Default for DeviceOptions {
    fn default() -> Self {
        Self {
            screen: None,
            device_scale_factor: 1.0,
            is_mobile: false,
            has_touch: false,
            user_agent: String::new(),
            user_agent_metadata: None,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserAgentMetadata {
    mobile: bool,
    model: String,
    architecture: String,
    platform: String,
    platform_version: String,
}

impl DeviceOptions {
    /// Validate the wire boundary before creating a Chromium context.
    pub fn parse(parameters: &Value, viewport: Option<&Viewport>) -> Result<Self, ErrorRecord> {
        let method = "browser.newContext";
        let screen = parameters
            .get("screen")
            .map(|value| parse::<Viewport>(method, value.clone()))
            .transpose()?;
        if screen
            .as_ref()
            .is_some_and(|size| size.width == 0 || size.height == 0)
        {
            return Err(invalid(
                method,
                "screen dimensions must be positive integers",
            ));
        }
        let device_scale_factor = parameters
            .get("deviceScaleFactor")
            .map(|value| parse::<f64>(method, value.clone()))
            .transpose()?
            .unwrap_or(1.0);
        if !device_scale_factor.is_finite() || device_scale_factor < 0.0 {
            return Err(invalid(
                method,
                "deviceScaleFactor must be finite and nonnegative",
            ));
        }
        let is_mobile = parameters
            .get("isMobile")
            .map(|value| parse::<bool>(method, value.clone()))
            .transpose()?
            .unwrap_or(false);
        if viewport.is_none() && (parameters.get("deviceScaleFactor").is_some() || is_mobile) {
            return Err(invalid(
                method,
                "deviceScaleFactor and mobile emulation require a non-null viewport",
            ));
        }
        let has_touch = parameters
            .get("hasTouch")
            .map(|value| parse::<bool>(method, value.clone()))
            .transpose()?
            .unwrap_or(false);
        let user_agent = parameters
            .get("userAgent")
            .map(|value| parse::<String>(method, value.clone()))
            .transpose()?
            .unwrap_or_default();
        let user_agent_metadata = parameters
            .get("userAgentMetadata")
            .map(|value| parse::<UserAgentMetadata>(method, value.clone()))
            .transpose()?;
        Ok(Self {
            screen,
            device_scale_factor: if device_scale_factor == 0.0 {
                1.0
            } else {
                device_scale_factor
            },
            is_mobile,
            has_touch,
            user_agent,
            user_agent_metadata,
        })
    }

    /// Screen orientation follows the emulated screen, independently of viewport size.
    pub fn metrics(&self, viewport: &Viewport) -> Value {
        let screen = self.screen.as_ref().unwrap_or(viewport);
        let orientation = if self.is_mobile {
            if screen.width > screen.height {
                json!({"angle":90,"type":"landscapePrimary"})
            } else {
                json!({"angle":0,"type":"portraitPrimary"})
            }
        } else {
            json!({"angle":0,"type":"landscapePrimary"})
        };
        json!({"width":viewport.width,"height":viewport.height,"screenWidth":screen.width,"screenHeight":screen.height,"deviceScaleFactor":self.device_scale_factor,"mobile":self.is_mobile,"screenOrientation":orientation})
    }

    pub fn user_agent_override(&self) -> Value {
        let mut parameters = json!({"userAgent":self.user_agent});
        if let Some(metadata) = &self.user_agent_metadata {
            parameters["userAgentMetadata"] = json!(metadata);
        }
        parameters
    }
}
