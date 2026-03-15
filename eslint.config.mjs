import { defineConfig } from "eslint/config"
import js from "@eslint/js"
import tseslint from "typescript-eslint"
import prettierConfig from "eslint-config-prettier"
import unusedImports from "eslint-plugin-unused-imports"
import zodPlugin from "eslint-plugin-zod"

export default defineConfig([
  js.configs.recommended,
  tseslint.configs.strict,
  zodPlugin.configs.recommended,
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "runs/", "indexes/"],
  },
  // Must be last — disables formatting rules that conflict with Prettier
  prettierConfig,
])
