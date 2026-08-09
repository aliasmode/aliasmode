// Bun bundles these imports; declare them so tsc doesn't choke on the modules.
declare module "*.html" {
  const content: import("bun").HTMLBundle;
  export default content;
}
declare module "*.css";
