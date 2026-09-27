# MAIA in brief

*A short, current overview. The "Ask about MAIA" box on the welcome page always reads this first, then the documentation sections that match the question. Reviewed 2026-09-26 (v1.6.x). When it disagrees with an older document, this one is right.*

## What MAIA is

MAIA (Medical AI Assistant) is free, open-source software for patients. Each patient has their own MAIA: a private AI that works only for them, and their own copy of their health records in a folder on their computer. It is built by volunteer patient advocates, and no company is behind it. The code is public at https://github.com/HIEofOne/self, so anyone, or any coding AI, can check what it does.

## Two editions

- **The Personal AS edition** is the new MAIA, running on test.agropper.xyz; maia.agropper.xyz is planned to switch to it. Your MAIA answers requests for your health information by rules you approve, and it can accept documents sent to you. It starts simple: other features stay hidden until you turn them on in Workbook → More features, or your private AI suggests one. "AS" stands for authorization server, the part that decides who may see what.
- **The full edition** is the earlier MAIA, with the setup wizard, a searchable knowledge base of your records, lists, deep links for chatting with your doctors, and public AIs. The User Guide and the FAQ were written for the full edition.

## Getting started (Personal AS edition)

You need Chrome on a computer that only you use. On the welcome page you confirm your email address, then GET STARTED opens a short setup checklist:

1. **Verify your email.** MAIA emails you when a request needs your decision or something was shared, plus a weekly summary. It never emails health information.
2. **Create a passkey**, so only you can sign in.
3. **Choose your MAIA folder** on your computer. MAIA keeps your own copy of everything there: your Patient Summary as a PDF, your rules, the request log, and documents sent to you.
4. **Join the host's group**, such as Trustee. The group suggests starter rules, for example "a doctor who has confirmed their email may see my current medications".
5. **Create your Patient Summary**, with your current medications, from an Apple Health export or by answering a few questions. You review and verify it.
6. **Confirm your rules and turn on sharing.** Read each rule, try it out and change it if you like. Nothing is shared before you turn sharing on.

## How requests work

Every request comes in through the same door, a public internet standard called GNAP (RFC 9635), and MAIA handles it the same way every time. It checks who is asking and what they can prove, such as a confirmed email or group membership, and what they want and why. Then your rules decide:

- **Share**, if a rule allows it. Only the privacy-filtered copy leaves: names and other details that identify you are replaced.
- **Ask you**, if no rule decides. You get an email and decide in MAIA.
- **Decline**, if a rule says no.

The requester is never told which rule decided. Health information never travels by email: a requester collects the answer from a secure page, with a permission that lasts an hour and works only in their own browser or program. A log of every request is saved in your folder.

Who can ask:

- **Anyone, directly**, with your personal request link or QR code, for example a new doctor before a visit.
- **Anyone, to a whole group**, with the group's request page, for example a researcher. The group passes the request to every member's MAIA but can't read the answers, and the requester never learns who is in the group.
- **Another group member**, from their own MAIA.
- **Someone else's MAIA**, for its own user. Your MAIA can also ask other MAIAs for you: your private AI can draft a request, and you decide whether to send it.
- **Software**, using the same standard.

Someone can also **add a document** to your MAIA, such as a radiology report. Adding needs its own rule. While a document waits for you, it is locked with a key that exists only in your folder; once accepted, it is saved in your folder under Received.

## Groups

A group is a community, such as a patient group or a practice, that suggests rules to its members. The group keeps a membership list, not medical records. Each member confirms or changes every rule, and each member's own rules decide every request. A MAIA host can run patients' MAIAs, groups, or both. trustee.ai is a group-only host: it runs two demonstration groups, Demo Patients and Demo Clinic, and keeps no health records. You join its groups from your own MAIA host. Use made-up records there.

## Your private AI

Each patient's private AI runs on DigitalOcean's AI platform, for that patient only. In the Personal AS edition it knows your Patient Summary, your rules and whether sharing is on. It helps you write rules, explains requests, drafts requests to other MAIAs and suggests features. It never decides who gets your information: your confirmed rules do, or you do. "Search all my records", which you can turn on, indexes the records in your folder so your private AI can search them; its answers cite the file and page they come from, as links. Workbook → More features and Saved Files show the indexing's progress.

## Public AIs

Below your private AI, the chat's "To:" menu lists four public AIs: commercial models such as GPT-5.4 Pro and Claude Fable 5.1, reached through DigitalOcean's serverless inference. They stay off until you turn on Public AIs; choosing one the first time asks. Everything in that chat goes to the company that runs the model you pick, and your summary and rules aren't sent unless they're in the chat. Some reason before they answer, and they can read an image you attach; an image stays in your browser, isn't saved with the chat, and goes only to a public AI that reads images.

## Privacy, trust and regulation

- Your folder holds your own copy of everything. The host keeps what your MAIA needs to answer while you're away, such as your summary, its privacy-filtered copy and your rules.
- Whoever runs and pays for the hosting could, in principle, reach the data on it. For full control, host your own MAIA on your own account. The code's author needs no access to anyone's data.
- MAIA is decision-support software. The FAQ explains why it falls outside FDA device regulation. It doesn't replace your clinicians.
- The security and privacy design, with its numbered invariants, is published in the repository and as a PDF linked from the welcome page.

## Running your own MAIA host

The README has a Deploy to DigitalOcean button. Hosting costs roughly $10–40 a month for a small group. Almost everything is derived from one DigitalOcean API token. A host can be set up as group-only (`MAIA_HOST_ROLE=group-only`), as trustee.ai is.

## Learn more

- The welcome page's two diagrams: "How MAIA groups connect" (/MAIA_Group_Network.html) and "How MAIA handles requests" (/MAIA_Request_Map.html).
- The community forum: https://forum.agropper.xyz. No personal health information there.
- The code and documentation: https://github.com/HIEofOne/self.
- Essays on Substack: https://trustee.substack.com.

## About "Ask Claude about MAIA"

Claude, an AI made by Anthropic, answers through DigitalOcean's serverless inference. With every question it gets this overview, a map of MAIA's code and documents, and the history of every merged pull request; it reads the exact files, document sections or pull requests it needs, shows what it looks up as it goes, and links to them. It lives at /ask; the welcome page's "Ask Claude about MAIA" card opens it. It can't see anyone's MAIA, records or account. It is not private, so don't type health information into it. Nothing you type is saved, but answers can be wrong: the code and documents themselves are the reference.
