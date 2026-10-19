# Managing calls and pinned folders

In **Call notes**, choose **Add folder…** in the page header. The macOS folder chooser opens in front of SS2. Choose a folder to pin it and select it as the Markdown destination. This works before creating your first call. Cancelling the chooser changes nothing. Selecting an already pinned folder selects its existing pin.

For an open call, the bottom bar shows the selected folder and **Save Markdown**. **Add folder…** also appears there. Use the × button beside the destination to unpin it; this removes only the shortcut, leaving the folder and files intact. Saved calls also expose **Save a copy** and the reveal action.

To remove a call, select it and choose **Delete call** beside its recording actions. The confirmation names the call, explains what is removed, and initially focuses **Cancel**. **Delete permanently** removes this call's notes, transcript, private saved audio, local recovery journal, and agent drafts, and revokes its agent grant. Original imported files and exported Markdown—including exported agent drafts—remain where they are. Other calls, pinned folders, provider settings and the encrypted API key are preserved. Copies already supplied to other apps or agents cannot be retracted.

Deletion is unavailable while that call is recording or transcribing. The main process also blocks deletion during microphone permission/startup, unfinished transcription jobs and audio preparation. Stop recording or wait for the active work to finish, then retry. Interrupted calls can be deleted. Deletion is permanent and does not use the system Trash.

Only the trusted control-panel main frame can invoke call actions. Call reads, saves and updates require a registered ID and a regular, confined call directory and session file. Stale saves and playback capabilities cannot reopen a deleted call. Existing files outside the call directory are never deletion targets, including symlink destinations.
