/**
 * `.html` imports resolve to the file's text.
 *
 * Backed by the `[[rules]] type = "Text"` entry in wrangler.toml — esbuild inlines
 * the file as a string at build time. Without this declaration TypeScript has no
 * type for the import, and without the wrangler rule the build has no loader.
 * Both are required; neither implies the other.
 */
declare module '*.html' {
  const content: string
  export default content
}
