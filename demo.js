// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["metadata"],
  viewport: { width: 1200, height: 760 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("data/notes.txt");
    await lumine.project.setPaths([fixture("data")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Inspect a plotted waveform and its image metadata.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, fixture, waitFor } = context;
        {
          state.document = await lumine.workspace.open(fixture("data/waveform.png"));
          await lumine.workspace.paneForItem(state.editor).destroyItem(state.editor, true);
          await waitFor(() => state.document.view?.loaded, "loaded image");
          lumine.commands.dispatch(state.document.view.element, "image-editor:show-properties");
          await waitFor(
            () => document.querySelector(".metadata")?.getAttribute("aria-busy") === "false",
            "loaded image metadata",
          );
          lumine.commands.dispatch(state.document.view.element, "image-editor:fit-to-view");
        }
      },
      ready({ state }) {
        return Boolean(
          state.document.view?.loaded &&
          document.querySelector(".metadata")?.getAttribute("aria-busy") === "false",
        );
      },
    },
  ],
  async cleanup() {},
};
