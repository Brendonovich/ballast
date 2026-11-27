// A transparent alert overlay for an OBS Browser Source. It is plain DOM:
// the artifact page starts with `?background=transparent`, and the CSS below
// keeps every layer transparent so OBS composites it over the scene.
const style = `
  :root { color-scheme: normal; }
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  .overlay { position: fixed; inset: 0; display: grid; place-items: center; }
  .alert {
    display: grid; justify-items: center; gap: 10px;
    padding: 28px 64px;
    font-family: "Arial Black", ui-sans-serif, system-ui, sans-serif;
    text-align: center;
    color: #fff;
    text-shadow: 0 4px 0 rgba(0, 0, 0, 0.35);
    background: linear-gradient(135deg, #ff2d6f, #7a2dff);
    border: 4px solid #fff;
    border-radius: 28px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
    animation: pop 900ms cubic-bezier(0.2, 1.6, 0.4, 1) both;
  }
  .alert small { font: 600 22px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.35em; text-transform: uppercase; opacity: 0.85; }
  .alert strong { font-size: 96px; line-height: 1; letter-spacing: 0.04em; }
  @keyframes pop { from { opacity: 0; transform: scale(0.6) rotate(-4deg); } to { opacity: 1; transform: scale(1) rotate(0deg); } }
  @media (prefers-reduced-motion: reduce) { .alert { animation: none; } }
`;

export default (root: HTMLElement): void => {
  const styleElement = document.createElement("style");
  styleElement.textContent = style;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="alert">
      <small>Ballast</small>
      <strong>NEW FOLLOWER</strong>
    </div>
  `;
  root.replaceChildren(styleElement, overlay);
};
