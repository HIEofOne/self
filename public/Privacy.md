# Privacy

## Who can see what

Every MAIA host is run by someone: whoever controls its cloud account, its *operator*. This is what each party can and can't see.

**A group admin on a host that runs only groups (such as trustee.ai)** never sees patient records or message content. They see:
- the members' aliases, and which MAIA host each member uses;
- join requests;
- requests sent to the group: the requester's confirmed email, their name, what they asked for and why, and their message;
- how many members answered.

They don't see the answers, which are sealed to the requester, or what members write to each other: the group relays sealed messages and sees only who wrote to whom, and when.

**The operator of a patient's MAIA host** can see what the patient keeps on that host:
- the Patient Summary and its privacy-filtered copy;
- uploaded record files and the search index made from them;
- saved chats;
- requests to the patient, including the requesters' messages;
- the activity log (maia-log), which includes file names;
- the patient's email address.

A group run on a host that also holds patients' MAIAs is run by that host's admin, so this applies to the group's members on that host.

**MAIA's admin account** manages accounts and Credits. It can't open a patient's records, summary, chats, requests or messages through the app. The operator can still read the host's database directly, as above.

**Messages between group members** are sealed in the sender's browser to each recipient's MAIA folder key, with a copy sealed to the sender's own. Hosts and the group relay carry and store them sealed. A message opens only in MAIA on a computer that has the member's MAIA folder, so if the folder is lost, its sealed messages can't be opened. The one exception: a member whose MAIA hasn't registered a folder key yet gets messages sealed by the sender's host to theirs, which both hosts can read. MAIA says so when you send one.

Requests to a patient and the answers their sharing rules give are handled by the patient's host, so the rules can answer while the patient is offline.

**What no host can see:**
- the patient's MAIA folder on their own computer;
- documents someone sends a patient, while they wait: they're sealed to the folder key, and deleted from the host once accepted or declined;
- answers to group requests, which are sealed to the requester;
- messages between group members that were sealed in the browser.

**AI:** Private AI chats pass through the host and DigitalOcean's AI service, but aren't stored unless the patient saves them. MAIA records which AI was asked, never the text. Public AIs such as Claude or ChatGPT see only what's in a chat the patient chooses to send them.

**The only way to keep a host's operator from seeing a patient's data** is to run your own host: your own copy of the open-source code, on your own DigitalOcean account. Then the operator is you.

*This describes MAIA's Personal AS edition.*

---

**Privacy Note:**

This demo will not share your health records or chats with anyone unless you choose to share a chat with a public AI like ChatGPT or via a deep link. The demo host (agropper.xyz, me) could access your records and chats but you will be registered under a pseudonym and I have no reason to fish through anybody's records without a written request. For privacy from me as open source code and cloud hosting administrator, you should get your own copy of the open source code and a Digital Ocean account. Since I don't want to see your records, MAIA creates a maia-setup-log.pdf log file that you can email or post for help. The file has no personal information other than possibly in the file names themselves — if concerned, edit the file names of your records files.

**No Password**

If you are on your own private computer, you can try MAIA without a password or passkey as long as you use the same browser each time. When you "Sign Out" of MAIA, your private records will be backed up locally and can be removed from the cloud. When you return to this MAIA welcome page, we check if your cloud records are still available. If they are not, you may restore MAIA from the local MAIA folder.

**Passkeys**

Setting a Passkey when you sign-out of a No Password account allows you to access MAIA from another computer, browser, or mobile device.

**The Wizard**

Greets you when you start a new MAIA to upload and process your health records into an AI-enhanced knowledge base accessible your Private AI agent. Prepare for the wizard by collecting all the records **for one patient** in a folder on your computer. More records can be added or removed at any time. If you have an iPhone or iPad, Apple Health makes it particularly convenient to collect records from most of the patient portals that you have a password for. In the Apple Health app, use "Export PDF" to save the file to your MAIA folder. Your records will be collected in minutes and MAIA will create a detailed index and will suggest a Current Medications list for you to edit and verify if needed. Apple Health PDF records are convenient and well organized, but they don't have the signed encounter notes and other details you get by asking for records from each patient portal.

With MAIA, public AIs like Claude or ChatGPT will not have access to your records except as part of a chat that you see and control. Doctors and other users you invite by sharing a link will have access to your records by asking your Private AI questions in the chat. You can disable this option in your My Agent settings.

**AI IS NOT PERFECT**

MAIA gives you the opportunity to edit and verify whatever you or others might see in the chats. The Wizard requires verification for Current Medications and the Patient Summary. It is your responsibility to check the responses from Private AI as well as public AIs you choose. MAIA helps you verify by offering direct links to information in the PDF files you imported from your health care providers.
