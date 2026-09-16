// Secrets are not present in wrangler.toml, so `wrangler types` cannot emit
// them; this declaration merges into the generated Env interface.
interface Env {
  GITHUB_TOKEN: string;
  ADMIN_TOKEN: string;
}
