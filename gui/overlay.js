const selection = document.getElementById("selection");
let start = null;
let end = null;

function updateSelection() {
  if (!start || !end) {
    selection.style.display = "none";
    return;
  }
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(start.x - end.x);
  const height = Math.abs(start.y - end.y);
  selection.style.display = "block";
  selection.style.left = `${left}px`;
  selection.style.top = `${top}px`;
  selection.style.width = `${width}px`;
  selection.style.height = `${height}px`;
}

window.addEventListener("mousedown", (evt) => {
  start = { x: evt.clientX, y: evt.clientY };
  end = start;
  updateSelection();
});

window.addEventListener("mousemove", (evt) => {
  if (!start) return;
  end = { x: evt.clientX, y: evt.clientY };
  updateSelection();
});

window.addEventListener("mouseup", async (evt) => {
  if (!start) return;
  end = { x: evt.clientX, y: evt.clientY };
  updateSelection();
  const width = Math.abs(start.x - end.x);
  const height = Math.abs(start.y - end.y);
  if (width < 5 || height < 5) {
    await window.screenAnalysis.cancelSnip();
    return;
  }
  const bounds = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width,
    height,
  };
  await window.screenAnalysis.captureRegion(bounds);
});

window.addEventListener("keydown", async (evt) => {
  if (evt.key === "Escape") {
    await window.screenAnalysis.cancelSnip();
  }
});
