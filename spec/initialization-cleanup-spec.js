describe("Image Editor initialization cleanup", () => {
  it("unloads a recovery bootstrap before runtime views have activated", async () => {
    const pack = lumine.packages.loadPackage("image-editor");
    pack.requireMainModule();
    pack.initializeForExternalUse("document restoration");
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivated).toBe(false);

    await lumine.packages.unloadPackage("image-editor", { serialize: false });

    expect(lumine.packages.isPackageLoaded("image-editor")).toBe(false);
  });
});
