// Vendored dependency source. `walkRepository` prunes `vendor/` the way it prunes `node_modules/`,
// so this file never becomes a module and the plugin never spells the rule.
package dep

func Helper() string { return "vendored" }
