export function setupIpcListeners({
    windowApi,
    setScreenshotsCount,
    updateUi,
    addChatMessage,
    setAnalyzing,
    showLoadingOverlay,
    hideLoadingOverlay,
    showFeedback,
    showEmergencyOverlay,
    transcriptionManager,
    toggleMasterTranscription,
    askAiWithSessionContext,
    isAskAiShortcutEnabled,
    addMonitorLog,
    scrollChat,
    shortcutActions,
    getActiveScreenAiStream,
    clearActiveScreenAiStream
}) {
    if (!windowApi) {
        console.error('electronAPI not available');
        return;
    }

    windowApi.onScreenshotTakenStealth((count) => {
        const payload = typeof count === 'object' && count !== null ? count : { count };
        setScreenshotsCount(Number(payload.count || 0));
        updateUi();
        addChatMessage('screenshot', 'Screenshot captured', {
            screenshotId: typeof payload.screenshotId === 'string' ? payload.screenshotId : null
        });
        showFeedback('Screenshot captured', 'success');
    });

    windowApi.onAnalysisStart(() => {
        setAnalyzing(true);
        showLoadingOverlay();
        const stream = typeof getActiveScreenAiStream === 'function' ? getActiveScreenAiStream() : null;
        if (!stream) {
            addChatMessage('system', 'Analyzing screenshots...');
        }
    });

    windowApi.onAnalysisResult((data) => {
        setAnalyzing(false);
        hideLoadingOverlay();

        const stream = typeof getActiveScreenAiStream === 'function' ? getActiveScreenAiStream() : null;
        console.log('[onAnalysisResult] stream active:', !!stream, 'has error:', !!data.error);
        if (data.error) {
            addChatMessage('system', `Error: ${data.error}`);
            showFeedback('Analysis failed', 'error');
        } else if (stream) {
            stream.finalize(data.text);
            showFeedback('Analysis complete', 'success');
        } else {
            console.log('[onAnalysisResult] No active stream - creating new message');
            addChatMessage('ai-response', data.text);
            showFeedback('Analysis complete', 'success');
        }

        // Clean up the screen AI stream after processing the result
        if (typeof clearActiveScreenAiStream === 'function') {
            clearActiveScreenAiStream();
        }
    });

    windowApi.onSetStealthMode((enabled) => {
        showFeedback(enabled ? 'Stealth mode ON' : 'Stealth mode OFF', 'info');
    });

    windowApi.onEmergencyClear(() => {
        showEmergencyOverlay();
    });

    windowApi.onError((message) => {
        showFeedback(message, 'error');
    });

    windowApi.onVoskStatus((data) => {
        transcriptionManager.handleVoskStatus(data);
    });

    windowApi.onVoskPartial((data) => {
        transcriptionManager.handleVoskPartial(data);
    });

    windowApi.onVoskFinal((data) => {
        transcriptionManager.handleVoskFinal(data);
    });

    windowApi.onVoskError((data) => {
        transcriptionManager.handleVoskError(data);
    });

    windowApi.onVoskStopped((data) => {
        transcriptionManager.handleVoskStopped(data);
    });

    if (windowApi.onToggleVoiceRecognition) {
        windowApi.onToggleVoiceRecognition(() => {
            addMonitorLog('info', 'shortcut-event', 'Global shortcut toggled transcription');
            toggleMasterTranscription().catch((error) => {
                console.error('Global shortcut toggle failed:', error);
                addMonitorLog('error', 'shortcut-toggle-failed', error.message);
            });
        });
    }

    if (windowApi.onTriggerAskAi) {
        windowApi.onTriggerAskAi(() => {
            if (typeof isAskAiShortcutEnabled === 'function' && !isAskAiShortcutEnabled()) {
                addMonitorLog('info', 'shortcut-ask-ai-blocked', 'Global Ask AI shortcut ignored because Ask AI is disabled');
                return;
            }

            addMonitorLog('info', 'shortcut-event', 'Global Ask AI shortcut triggered');
            askAiWithSessionContext().catch((error) => {
                console.error('Global Ask AI trigger failed:', error);
                addMonitorLog('error', 'shortcut-ask-ai-failed', error.message);
            });
        });
    }

    if (windowApi.onTriggerShortcutAction) {
        windowApi.onTriggerShortcutAction((data) => {
            const action = data?.action;
            const handler = shortcutActions && typeof shortcutActions[action] === 'function'
                ? shortcutActions[action]
                : null;
            if (!handler) {
                return;
            }
            addMonitorLog('info', 'shortcut-event', `Global shortcut triggered: ${action}`);
            Promise.resolve(handler()).catch((error) => {
                console.error(`Global shortcut "${action}" failed:`, error);
                addMonitorLog('error', 'shortcut-action-failed', `${action}: ${error.message}`);
            });
        });
    }

    if (windowApi.onScrollChat) {
        windowApi.onScrollChat((data) => {
            const direction = data?.direction === 'up' ? 'up' : 'down';
            if (typeof scrollChat === 'function') {
                scrollChat(direction);
            }
        });
    }

    if (windowApi.onSetClickThrough) {
        windowApi.onSetClickThrough((data) => {
            const enabled = Boolean(data?.enabled);
            showFeedback(enabled ? 'Click-through ON' : 'Click-through OFF', 'info');
        });
    }

    if (windowApi.onSttDebug) {
        windowApi.onSttDebug((data) => {
            const source = data?.source ? transcriptionManager.normalizeSource(data.source) : null;
            addMonitorLog(
                data?.level || 'info',
                data?.event || 'stt-debug',
                data?.message || '',
                source,
                data?.meta || null,
                data?.ts || Date.now()
            );
        });
    }

    window.addEventListener('error', (event) => {
        addMonitorLog('error', 'renderer-error', event?.message || 'Renderer error');
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event?.reason;
        const message = typeof reason === 'string'
            ? reason
            : reason?.message || 'Unhandled promise rejection';
        addMonitorLog('error', 'renderer-rejection', message);
    });
}
