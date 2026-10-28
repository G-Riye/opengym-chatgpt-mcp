/* Single source of truth for the connector version.
   scripts/release.ps1 bumps this file, package.json stays in step, and both the MCP
   server (initialize → serverInfo.version) and get_capabilities / get_status read it. */
export const VERSION = '1.3.2';
