// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
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
      caption: "Inspect a plotted waveform in the image editor.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, fixture, waitFor } = context;
        state.document = await lumine.workspace.open(fixture("data/waveform.png"));
        await lumine.workspace.paneForItem(state.editor).destroyItem(state.editor, true);
        await waitFor(() => state.document.view?.loaded, "loaded image");
        const target = state.document.view.element;
        lumine.commands.dispatch(target, "image-editor:zoom-out");
        lumine.commands.dispatch(target, "image-editor:zoom-out");
      },
      ready({ state }) {
        const view = state.document.view;
        const image = view?.refs.image;
        return Boolean(
          view?.loaded &&
          image?.complete &&
          image.naturalWidth > 0 &&
          !view.smoothTransformRAF &&
          image.getBoundingClientRect().top >
            view.refs.imageControls.getBoundingClientRect().bottom,
        );
      },
    },
  ],
  async cleanup() {},
};
