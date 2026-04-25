# Terminal Command Management

Grav guards terminal commands with a whitelist/blacklist system:

- **Whitelist** — Commands that are always allowed (e.g. `npm install`, `git status`)
- **Blacklist** — Commands that are always blocked (e.g. `rm -rf /`, `shutdown`)
- **Test** — Check if a specific command would be allowed or blocked
- **View Lists** — See all current whitelist and blacklist entries

Use **Grav: Manage Terminal Commands** from the command palette or the Dashboard's "Manage Rules" button.
