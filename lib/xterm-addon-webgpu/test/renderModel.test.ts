import * as assert from "node:assert/strict";
import { RenderModel, INDICES_PER_CELL } from "../src/model/RenderModel.js";

describe("RenderModel", () => {
  it("allocates cols*rows*4 words on resize", () => {
    const m = new RenderModel();
    m.resize(80, 24);
    assert.equal(m.cells.length, 80 * 24 * INDICES_PER_CELL);
    assert.equal(m.lineLengths.length, 24);
    assert.equal(m.cols, 80);
    assert.equal(m.rows, 24);
  });

  it("does not reallocate when the cell count is unchanged", () => {
    const m = new RenderModel();
    m.resize(10, 10);
    const before = m.cells;
    m.resize(10, 10);
    assert.equal(m.cells, before, "same backing array reused");
  });

  it("computes a correct linear cell index", () => {
    const m = new RenderModel();
    m.resize(10, 5);
    assert.equal(m.cellIndex(0, 0), 0);
    assert.equal(m.cellIndex(1, 0), INDICES_PER_CELL);
    assert.equal(m.cellIndex(0, 1), 10 * INDICES_PER_CELL);
    assert.equal(m.cellIndex(3, 2), (2 * 10 + 3) * INDICES_PER_CELL);
  });

  it("stores and reads back the four words per cell", () => {
    const m = new RenderModel();
    m.resize(4, 4);
    m.setCell(2, 1, 0x41, 0x1234, 0x5678, 0x9abc);
    assert.equal(m.getContent(2, 1), 0x41);
    assert.equal(m.getBg(2, 1), 0x1234);
    assert.equal(m.getFg(2, 1), 0x5678);
    assert.equal(m.getExt(2, 1), 0x9abc);
  });

  it("does not bleed between adjacent cells", () => {
    const m = new RenderModel();
    m.resize(4, 4);
    m.setCell(1, 1, 1, 1, 1, 1);
    assert.equal(m.getContent(2, 1), 0);
    assert.equal(m.getContent(0, 1), 0);
  });

  it("clears all cell data", () => {
    const m = new RenderModel();
    m.resize(4, 4);
    m.setCell(0, 0, 9, 9, 9, 9);
    m.clear();
    assert.equal(m.getContent(0, 0), 0);
  });
});
