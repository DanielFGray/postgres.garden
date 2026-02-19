declare module "virtual:renderer-css" {
  const cssText: string;
  export default cssText;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
