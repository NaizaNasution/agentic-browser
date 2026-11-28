// Markdown files imported as text (esbuild's "text" loader, scripts/build.mjs).
declare module "*.md" {
  const text: string;
  export default text;
}
