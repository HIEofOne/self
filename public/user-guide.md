# MAIA User Guide

## 1. How MAIA Manages Your Files

MAIA organizes your files into three tiers: **temporary**, **archived**, and **indexed**. Each tier determines how long a file is kept and which AI models can access it.

### Temporary Files

When you upload a file using the paperclip icon in the chat, it behaves like uploading a file to ChatGPT: your Private AI can read it for the current conversation. When you reload the page you get a fresh chat and the uploaded file is gone from the cloud. (It is still on your computer, of course.)

### Archived Files

When you open the **Saved Files** tab in **My Stuff**, any temporary files are automatically copied to your archived folder. Archived files are preserved across sessions and allow you to add them to the knowledge base whenever you choose.

Your Private AI does *not* see archived files. They are simply stored, waiting for you to decide whether to index them.

### Indexed Files (Knowledge Base)

Indexed files live in your knowledge base. Your Private AI has full access to them in every conversation. To index a file:

1. Open **My Stuff > Saved Files**.
2. Click the amber **Add to Knowledge Base** badge on the file.
3. Click **Update and Index KB**. Indexing can take a few seconds to several minutes depending on file size.

You can remove a file from the knowledge base at any time by clicking its badge again. The file moves back to archived.

>Files are never placed in the knowledge base without your explicit action. Even during a restore, only files that were previously indexed are re-indexed.

## 2. Which AI Sees What

| File Type | Your Private AI | Public AI (Claude, etc.) | Invited Users (Deep Links) |
|---|---|---|---|
| Temporary (uploaded in chat) | Yes | Yes (in current chat only) | No |
| Archived | No | No | No |
| Indexed (Knowledge Base) | Yes | No | Yes (by default) |

## 3. Deep Links and Invited Users

You can invite other people, such as your physicians, to chat with your Private AI using a deep link. By default, deep-link users can query your knowledge base through your Private AI. You can disable this permission at the top of the **My Stuff > My Agent** tab.

## 4. My Stuff Tabs

The **My Stuff** dialog is your central dashboard. It contains eight tabs:

### Saved Files

Manage your archived and indexed files. When you open this tab, any temporary files are automatically archived. Each file shows a color-coded badge:

- **Amber "Add to Knowledge Base"** — file is archived; click to mark it for indexing.
- **Orange "To be added and indexed"** — file is marked for KB but not yet indexed. Click **Update and Index KB** to start.
- **Blue "Indexing in progress"** — indexing is running.
- **Blue "Indexed in Knowledge Base"** — file is indexed and available to your Private AI. Click to remove it from KB.

You can delete any file with the red trash icon. You can cancel an active indexing job; cancelled files return to archived.

### My AI Agent

View and edit the instructions for your Private AI agent. These instructions guide how your agent responds to you and to invited users.

At the top of this tab is a toggle: **Deep link users can chat with your Private AI**. Turn this off to prevent invited users from querying your knowledge base.

Below the instructions, the **Agent Knowledge Base** section shows which knowledge base is connected, its last indexing time, and the list of indexed files.

### Saved Chats

Browse your saved group chats. Each entry shows the date, last query, and participants. You can copy a deep link to share a chat or delete it. Click a chat to reopen it in the main chat window.

### Patient Summary

View, edit, and verify your AI-generated patient summary. The summary is created from your indexed files and can be edited directly. If MAIA detects changes to your records, a **Verify** button appears prompting you to review. Previous versions of the summary are available as buttons so you can compare or restore an earlier version.

### My Lists

Structured lists extracted from your records, such as your current medications. Lists are editable and are included in your local backup.

### Privacy Filter

Replace real names in your chat with pseudonyms before sharing. MAIA scans your chat for names and builds a mapping table (e.g., "Fred Friendly" becomes "Alex32 Rivers98"). Click **Filter Current Chat** to apply the pseudonyms. The mapping is shown as a table you can review.

### Patient Diary

A private journal for health notes, symptoms, or observations. Entries are grouped into bubbles by time. You can post a diary bubble into the chat to discuss it with your AI and/or caregiver. Entries are stored in your cloud database.

### References

Upload and manage reference files (PDFs, text) that you want available in chats without indexing them into your knowledge base. Click a reference to add it to the current chat. References are stored separately from your archived and indexed files.

## 5. Backup and Restore

MAIA automatically backs up your account data to a local folder on your computer whenever you are signed in and have connected a local folder. If your cloud account is ever lost or reset, MAIA can restore everything from this local backup.

### What gets backed up

- File metadata and indexing status
- Patient summary and current medications
- Agent instructions
- Saved chats
- My Lists

> **Important:** The actual file contents (PDFs, etc.) are stored in your local folder alongside the backup. During a restore, MAIA re-uploads them from your local folder. Files that were only archived (not indexed) are restored to archived status — they are not automatically indexed.

### Local Folder Contents

| File | Description |
|---|---|
| `maia-for-<name>.webloc` | A bookmark to your MAIA instance. Double-click to open MAIA in your browser. |
| `maia-log.pdf` | Printable PDF version of the setup log, including version and API model info. |
| `maia-state.json` | Full account snapshot: file list with indexing status, medications, patient summary, agent instructions, saved chats, and lists. |
| `*.PDF` / `*.pdf` | Your uploaded documents. These are re-uploaded from this folder during a restore. |
