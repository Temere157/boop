// The webui entry. Renders a centered `boop` title at the top of #app.
// Kept deliberately small — this exists to exercise the serve-and-strip
// pipeline (the title only appears if /ui/index.ts loads as a module),
// not to be a real frontend yet.
const app = document.getElementById("app");
if (app !== null) {
  const h1 = document.createElement("h1");
  h1.id = "boop";
  h1.textContent = "boop";
  app.appendChild(h1);
}
