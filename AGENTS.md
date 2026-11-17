<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep the public service catalog in Lovable Cloud; public reads expose only visible listings, while admin edits and salted-hash code checks stay server-verified with hashed, expiring sessions. Store uploaded images with each listing because public storage is unavailable, and enforce fixed listed prices again when creating checkout sessions.
- Create payment sessions in a TanStack server route calling Bachs with the BACHS_API_KEY project secret; expose only the hosted checkout URL to the browser so credentials stay private, and send Bachs success/cancel redirect URLs only from a publicly reachable origin because Bachs rejects machine-only addresses.
- Receive Bachs webhooks only at /api/public/bachs-webhook: verify the X-Bachs-Signature-V2 HMAC (any v1, 5-minute window) against BACHS_WEBHOOK_SECRET on the raw body before storing, dedupe by event id, and show events only inside the code-protected Admin Panel because payouts and disputes are private.
