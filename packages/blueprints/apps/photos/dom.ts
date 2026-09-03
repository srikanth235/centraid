export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector(`#${id}`) as T;
