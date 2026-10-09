use crate::*;

impl Engine {
    pub(crate) fn dialog_control(
        &self,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        operation.check()?;
        let owner = if method.starts_with("page.") {
            "page"
        } else {
            "context"
        };
        validate_keys(method, parameters, &[owner, "enabled"])?;
        let enabled = parameters["enabled"]
            .as_bool()
            .ok_or_else(|| invalid(method, "enabled must be a boolean"))?;
        if enabled
            && self.maximum_pending_operations
                < flashwright_protocol::MINIMUM_DIALOG_PENDING_OPERATIONS
        {
            return Err(ErrorRecord::new(
                ErrorCode::ResourceLimit,
                method,
                "dialog subscriptions require at least two pending operation slots",
            ));
        }
        let identifier = identifier(parameters, owner, method)?;
        if owner == "page" {
            let page = self.page(identifier, method)?;
            let state = page.state.state.lock().unwrap();
            state.check(method)?;
            page.state.dialogs.lock().unwrap().subscribed = enabled;
        } else {
            self.context(identifier, method)?
                .state
                .dialog_enabled
                .store(enabled, Ordering::Relaxed);
        }
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        pending_operations: usize,
    ) -> (Engine, Arc<PageState>, Arc<context_state::ContextState>) {
        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits {
                pending_operations,
                ..Default::default()
            },
        );
        let page = Arc::new(PageState::default());
        let context = Arc::new(context_state::ContextState::default());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: devices::DeviceOptions::default(),
                settings: context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: context.clone(),
                published: true,
            },
        );
        engine.registry.lock().unwrap().pages.insert(
            "page".into(),
            Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: page.clone(),
            },
        );
        (engine, page, context)
    }

    #[test]
    fn insufficient_pending_capacity_rejects_subscription_without_mutation() {
        let (engine, page, context) = fixture(1);
        let (_sender, receiver) = watch::channel(false);
        let operation = Operation::new("dialog.subscribe".into(), None, receiver);
        for owner in ["page", "context"] {
            let error = engine
                .dialog_control(
                    &format!("{owner}.dialog.subscribe"),
                    &json!({ owner: owner, "enabled": true }),
                    &operation,
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::ResourceLimit);
        }
        assert!(!page.dialogs.lock().unwrap().subscribed);
        assert!(!context.dialog_enabled.load(Ordering::Relaxed));
    }

    #[test]
    fn controls_settle_synchronously_while_renderer_input_and_locator_locks_are_held() {
        let (engine, page, context) = fixture(2);
        let _input = page.native_input.try_lock().unwrap();
        let _locator = page.locator_realms.try_lock().unwrap();
        let (_sender, receiver) = watch::channel(false);
        let operation = Operation::new("dialog.subscribe".into(), None, receiver);
        for enabled in [true, false, true] {
            for owner in ["page", "context"] {
                assert_eq!(
                    engine
                        .execute_control(
                            &format!("{owner}.dialog.subscribe"),
                            &json!({ owner: owner, "enabled": enabled }),
                            &operation
                        )
                        .unwrap()
                        .unwrap(),
                    Value::Null
                );
            }
            assert_eq!(page.dialogs.lock().unwrap().subscribed, enabled);
            assert_eq!(context.dialog_enabled.load(Ordering::Relaxed), enabled);
        }
    }

    #[test]
    fn cancellation_before_control_acceptance_preserves_subscription_state() {
        let (engine, page, _) = fixture(2);
        let (sender, receiver) = watch::channel(false);
        sender.send(true).unwrap();
        let operation = Operation::new("page.dialog.subscribe".into(), None, receiver);
        let error = engine
            .dialog_control(
                "page.dialog.subscribe",
                &json!({ "page": "page", "enabled": true }),
                &operation,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(!page.dialogs.lock().unwrap().subscribed);
    }
}
