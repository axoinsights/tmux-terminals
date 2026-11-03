# tmux-terminals site

Static one-page site for https://tmux-terminals.axoinsights.com/ (no build step, no framework).

- Preview: `cd site && python3 -m http.server 8791`, then open http://localhost:8791/
- Deploy: in Cloudflare Pages create a new project from the GitHub repo `axoinsights/tmux-terminals`.
- Set the build command to none and the build output directory to `site`.
- After the first deploy, add the custom domain `tmux-terminals.axoinsights.com` under Custom domains.
- Fonts load from Google Fonts, the same as www.axoinsights.com. Nothing else is external.
