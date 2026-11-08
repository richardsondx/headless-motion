import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countupValue, countupText, formatCountup } from "../../src/chart/countup.mjs";
import { barraceState } from "../../src/chart/barrace.mjs";
import { barState } from "../../src/chart/bar.mjs";

const CU = { kind: "countup", from: 0, to: 12800, start: 24, duration: 96, ease: "easeOutCubic", format: { thousands: true, decimals: 0 } };

describe("countup", () => {
  it("starts at from and ends exactly at to", () => {
    assert.equal(countupValue(CU, 24), 0);
    assert.equal(countupValue(CU, 120), 12800);
    assert.equal(countupValue(CU, 200), 12800);
  });
  it("formats with thousands separators", () => {
    assert.equal(countupText(CU, 120), "12,800");
    assert.equal(formatCountup(1234.5, { decimals: 1, thousands: true, prefix: "$" }), "$1,234.5");
  });
});

const RACE = {
  kind: "barrace",
  rows: [
    { f: 0, values: { Alpha: 40, Beta: 30, Gamma: 20 } },
    { f: 120, values: { Alpha: 55, Beta: 70, Gamma: 25 } },
  ],
  slide: 12,
  format: { decimals: 0, thousands: true },
};

describe("barrace", () => {
  it("ranks at keyframe rows only", () => {
    const s0 = barraceState(RACE, 0);
    assert.deepEqual(s0.map((s) => s.name), ["Alpha", "Beta", "Gamma"]);
    assert.deepEqual(s0.map((s) => s.slot), [0, 1, 2]);
    const sEnd = barraceState(RACE, 132);
    assert.deepEqual(sEnd.map((s) => s.name), ["Beta", "Alpha", "Gamma"]);
    assert.deepEqual(sEnd.map((s) => s.slot), [0, 1, 2]);
  });
  it("slides between slots, never re-sorts mid-slide", () => {
    const mid = barraceState(RACE, 127);
    const beta = mid.find((s) => s.name === "Beta");
    const alpha = mid.find((s) => s.name === "Alpha");
    assert.ok(beta.slot > 0 && beta.slot < 1, "Beta slot is fractional mid-slide");
    assert.ok(alpha.slot > 0 && alpha.slot < 1, "Alpha slot is fractional mid-slide");
    assert.equal(mid[0].name, "Beta", "Beta leads the order once its slot passes Alpha");
  });
  it("ties break by name A to Z", () => {
    const tied = { kind: "barrace", rows: [{ f: 0, values: { Zulu: 10, Able: 10 } }], slide: 12 };
    assert.deepEqual(barraceState(tied, 0).map((s) => s.name), ["Able", "Zulu"]);
  });
});

describe("bar", () => {
  it("widths are value over max", () => {
    const s = barState({ A: 50, B: 25 });
    assert.equal(s.find((x) => x.name === "A").width, 1);
    assert.equal(s.find((x) => x.name === "B").width, 0.5);
  });
});
