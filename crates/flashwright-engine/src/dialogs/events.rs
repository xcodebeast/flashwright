use super::handling::PreparedDialogHandling;
use super::state::DialogKind;
use crate::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosingFields {
    frame_id: String,
}

impl Engine {
    /// Event processing never waits on the renderer, including when there are no user listeners.
    pub(crate) fn dialog_event(
        self: &Arc<Self>,
        identifier: &str,
        page: &Page,
        method: &str,
        raw: &str,
    ) -> Result<(), ErrorRecord> {
        let mut state = page.state.state.lock().unwrap();
        if state.failure.is_some() {
            return Ok(());
        }
        if method == "Page.javascriptDialogClosed" {
            let fields: ClosingFields = serde_json::from_str(raw).map_err(|error| {
                ErrorRecord::new(ErrorCode::Protocol, "page.dialog", error.to_string())
            })?;
            if page
                .state
                .dialogs
                .lock()
                .unwrap()
                .closed(&page.session_identifier, &fields.frame_id)
            {
                state.dialog_open = false;
                state.sequence += 1;
                page.state.changed.send_replace(state.sequence);
            }
            return Ok(());
        }
        let context = self.context(&page.context_identifier, "page.dialog")?;
        let browser = self.browser(&context.browser_identifier, "page.dialog")?;
        let mut dialogs = page.state.dialogs.lock().unwrap();
        let occurrence = dialogs.open(
            &self.dialog_budget,
            self.identifier("dialog"),
            identifier,
            &page.session_identifier,
            raw,
        )?;
        state.dialog_open = true;
        state.sequence += 1;
        page.state.changed.send_replace(state.sequence);
        let context_subscribed = context.state.dialog_enabled.load(Ordering::Relaxed);
        if page.state.purpose == PagePurpose::Public
            && (context_subscribed || (state.published && dialogs.subscribed))
        {
            // A modal raised during page initialization cannot wait for page publication.
            self.emit(
                if state.published {
                    identifier
                } else {
                    &page.context_identifier
                },
                "dialog",
                json!({
                    "dialog": occurrence.identifier,
                    "page": identifier,
                    "dialogJson": occurrence.event_json.as_ref(),
                }),
            );
            return Ok(());
        }
        let claimed = dialogs.claim(&occurrence.identifier, "page.dialog")?;
        let prepared = PreparedDialogHandling::start(
            self,
            page.clone(),
            browser,
            claimed,
            occurrence.kind == DialogKind::Beforeunload,
            None,
        );
        drop(dialogs);
        drop(state);
        tokio::spawn(async move {
            let (_cancellation, receiver) = watch::channel(false);
            let operation = Operation::new(
                "page.dialog".into(),
                Some(tokio::time::Instant::now() + Duration::from_secs(5)),
                receiver,
            );
            if let Err(error) = prepared.finish(&operation).await {
                // The affected page has already been retired, retaining the original failure.
                eprintln!("flashwright dialog cleanup: {}", error.message);
            }
        });
        Ok(())
    }
}
