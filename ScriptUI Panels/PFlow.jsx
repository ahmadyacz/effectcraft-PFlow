// PFlow for EffectCraft: a Bezier easing-curve editor that saves curves and applies them to
// the selected keyframes.
//
// A dockable ScriptUI panel (install into "Scripts/ScriptUI Panels", then Window > PFlow.jsx).
// Works only with After Effects' documented scripting API, so it also runs in After Effects.
//
// How it works
//   * The curve is a CSS-style cubic Bezier (x1, y1, x2, y2) from (0,0) to (1,1).
//     Drag the two handles in the graph, type the four numbers, or pick a preset.
//   * "Apply" eases every pair of neighbouring selected keyframes (of any property) with the
//     curve: out side of the first key, in side of the second. Speeds are scaled to each
//     segment, so the same curve fits any distance and duration (one undo step).
//   * "From Keys" reads the curve of the first selected pair back into the editor.
//   * Your own presets are kept with app.settings (section "PFlow", key "presets") as JSON:
//     {"version": 1, "presets": [{"name": "...", "curve": [x1, y1, x2, y2]}]}
//
// Original work by Puuncture, MIT License. The built-in curves are the widely published standard
// easing values (easings.net / CSS), not taken from any third-party panel.

(function pflow(thisObj) {
  var SECTION = "PFlow";
  var KEY = "presets";
  var MAX_NAME = 64;
  var MIN_INFLUENCE = 0.1;   // percent, After Effects' minimum
  var MAX_SPEED = 1000;      // relative to the segment's average speed
  var X_MIN = 0, X_MAX = 1;
  var Y_MIN = -2, Y_MAX = 3;
  var VIEW_LO = -0.5, VIEW_HI = 1.5; // value range shown in the graph
  var BEZIER = KeyframeInterpolationType.BEZIER;
  var HOLD = KeyframeInterpolationType.HOLD;

  // ------------------------------------------------------------------ curves

  function finite(v) { return typeof v === "number" && isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function C(x1, y1, x2, y2) { return [x1, y1, x2, y2]; }

  // A valid copy of a curve, or null.
  function sane(c) {
    if (!(c instanceof Array) || c.length !== 4) return null;
    for (var i = 0; i < 4; i++) if (!finite(c[i])) return null;
    return C(clamp(c[0], X_MIN, X_MAX), clamp(c[1], Y_MIN, Y_MAX), clamp(c[2], X_MIN, X_MAX), clamp(c[3], Y_MIN, Y_MAX));
  }

  function round(v, places) {
    var f = Math.pow(10, places);
    return Math.round(v * f) / f;
  }

  function curveText(c) {
    return round(c[0], 3) + ", " + round(c[1], 3) + ", " + round(c[2], 3) + ", " + round(c[3], 3);
  }

  // Four numbers anywhere in the text ("0.4, 0, 0.2, 1" or "cubic-bezier(.4,0,.2,1)").
  function parseCurve(text) {
    var m = String(text).match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi);
    if (!m || m.length < 4) return null;
    return sane(C(parseFloat(m[0]), parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])));
  }

  // The standard easing families (sine, quad … back) as In / Out / In-Out.
  var BUILT_IN = [
    { name: "Linear", curve: C(0.333, 0.333, 0.667, 0.667) },
    { name: "Ease (CSS)", curve: C(0.25, 0.1, 0.25, 1) },
    { name: "Standard (Material)", curve: C(0.4, 0, 0.2, 1) },
    { name: "Sine In", curve: C(0.12, 0, 0.39, 0) },
    { name: "Sine Out", curve: C(0.61, 1, 0.88, 1) },
    { name: "Sine In-Out", curve: C(0.37, 0, 0.63, 1) },
    { name: "Quad In", curve: C(0.11, 0, 0.5, 0) },
    { name: "Quad Out", curve: C(0.5, 1, 0.89, 1) },
    { name: "Quad In-Out", curve: C(0.45, 0, 0.55, 1) },
    { name: "Cubic In", curve: C(0.32, 0, 0.67, 0) },
    { name: "Cubic Out", curve: C(0.33, 1, 0.68, 1) },
    { name: "Cubic In-Out", curve: C(0.65, 0, 0.35, 1) },
    { name: "Quart In", curve: C(0.5, 0, 0.75, 0) },
    { name: "Quart Out", curve: C(0.25, 1, 0.5, 1) },
    { name: "Quart In-Out", curve: C(0.76, 0, 0.24, 1) },
    { name: "Quint In", curve: C(0.64, 0, 0.78, 0) },
    { name: "Quint Out", curve: C(0.22, 1, 0.36, 1) },
    { name: "Quint In-Out", curve: C(0.83, 0, 0.17, 1) },
    { name: "Expo In", curve: C(0.7, 0, 0.84, 0) },
    { name: "Expo Out", curve: C(0.16, 1, 0.3, 1) },
    { name: "Expo In-Out", curve: C(0.87, 0, 0.13, 1) },
    { name: "Circ In", curve: C(0.55, 0, 1, 0.45) },
    { name: "Circ Out", curve: C(0, 0.55, 0.45, 1) },
    { name: "Circ In-Out", curve: C(0.85, 0, 0.15, 1) },
    { name: "Back In", curve: C(0.36, 0, 0.66, -0.56) },
    { name: "Back Out", curve: C(0.34, 1.56, 0.64, 1) },
    { name: "Back In-Out", curve: C(0.68, -0.6, 0.32, 1.6) }
  ];

  // The curve as After Effects eases: influence (percent) and speed (relative to the segment's
  // average speed, 1 = a straight line) of the out side of the first key and the in side of the
  // second. The handles sit at (outInfluence, outSpeed * outInfluence) and
  // (1 - inInfluence, 1 - inSpeed * inInfluence).
  function toEases(c) {
    var ox = clamp(c[0], MIN_INFLUENCE / 100, 1);
    var ix = clamp(1 - c[2], MIN_INFLUENCE / 100, 1);
    return {
      outInfluence: ox * 100,
      outSpeed: clamp(c[1] / ox, -MAX_SPEED, MAX_SPEED),
      inInfluence: ix * 100,
      inSpeed: clamp((1 - c[3]) / ix, -MAX_SPEED, MAX_SPEED)
    };
  }

  function fromEases(e) {
    var ox = e.outInfluence / 100, ix = e.inInfluence / 100;
    return sane(C(ox, e.outSpeed * ox, 1 - ix, 1 - e.inSpeed * ix));
  }

  function mirrored(c) { return C(1 - c[2], 1 - c[3], 1 - c[0], 1 - c[1]); } // play it backwards

  // ------------------------------------------------------------------ presets

  function cleanName(name) {
    var n = String(name === undefined || name === null ? "" : name).replace(/^\s+|\s+$/g, "");
    return n.length > 0 && n.length <= MAX_NAME ? n : null;
  }

  function find(list, name) {
    var key = String(name).toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i].name.toLowerCase() === key) return i;
    return -1;
  }

  function parsePresets(text) {
    var out = [], doc;
    try { doc = JSON.parse(text); } catch (e) { return out; }
    var list = doc && doc.presets instanceof Array ? doc.presets : (doc instanceof Array ? doc : []);
    for (var i = 0; i < list.length; i++) {
      var name = cleanName(list[i] && list[i].name), c = sane(list[i] && list[i].curve);
      if (name && c && find(BUILT_IN, name) < 0 && find(out, name) < 0) out.push({ name: name, curve: c });
    }
    return out;
  }

  function loadUser() {
    try {
      if (!app.settings.haveSetting(SECTION, KEY)) return [];
      return parsePresets(app.settings.getSetting(SECTION, KEY));
    } catch (e) {
      return [];
    }
  }

  function saveUser(list) {
    app.settings.saveSetting(SECTION, KEY, JSON.stringify({ version: 1, presets: list }));
  }

  // ------------------------------------------------------------------ keyframes

  // Pairs of neighbouring selected keyframes in the active comp: {prop, key} (the earlier key).
  function selectedPairs() {
    var comp = app.project.activeItem, out = [];
    if (!(comp instanceof CompItem)) return out;
    var props = comp.selectedProperties;
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      if (p.propertyType !== PropertyType.PROPERTY || p.numKeys < 2 || !p.isInterpolationTypeValid(BEZIER)) continue;
      var keys = p.selectedKeys;
      for (var k = 0; k + 1 < keys.length; k++) if (keys[k + 1] === keys[k] + 1) out.push({ prop: p, key: keys[k] });
    }
    return out;
  }

  function pathLength(a, outT, inT, b) {
    var n = Math.max(a.length, b.length), len = 0, prev = null, pts = [];
    for (var d = 0; d < n; d++) pts.push([a[d] || 0, (a[d] || 0) + (outT[d] || 0), (b[d] || 0) + (inT[d] || 0), b[d] || 0]);
    for (var s = 0; s <= 128; s++) {
      var t = s / 128, u = 1 - t, pt = [], sq = 0;
      for (var e = 0; e < n; e++) pt.push(u * u * u * pts[e][0] + 3 * u * u * t * pts[e][1] + 3 * u * t * t * pts[e][2] + t * t * t * pts[e][3]);
      if (prev) {
        for (var f = 0; f < n; f++) sq += (pt[f] - prev[f]) * (pt[f] - prev[f]);
        len += Math.sqrt(sq);
      }
      prev = pt;
    }
    return len;
  }

  function layerOf(p) { return p.propertyGroup(p.propertyDepth); }

  // Average speed of the segment key a -> a+1, one entry per ease the property has (null when
  // the segment has no duration).
  function slopes(p, a) {
    var stretch = layerOf(p).stretch || 100;
    var dur = (p.keyTime(a + 1) - p.keyTime(a)) * 100 / stretch;
    if (!(dur > 0) || !isFinite(dur)) return null;
    var n = Math.max(1, p.keyOutTemporalEase(a).length), out = [], i;
    var v0 = p.keyValue(a), v1 = p.keyValue(a + 1), vt = p.propertyValueType;
    if (vt === PropertyValueType.TwoD_SPATIAL || vt === PropertyValueType.ThreeD_SPATIAL) {
      var speed = pathLength(v0, p.keyOutSpatialTangent(a), p.keyInSpatialTangent(a + 1), v1) / dur;
      for (i = 0; i < n; i++) out.push(speed);
    } else if (typeof v0 === "number" && typeof v1 === "number") {
      out.push((v1 - v0) / dur);
    } else if (v0 instanceof Array && v1 instanceof Array && v0.length === v1.length) {
      for (i = 0; i < n; i++) out.push(((v1[i] || 0) - (v0[i] || 0)) / dur);
    } else {
      for (i = 0; i < n; i++) out.push(1 / dur); // shapes etc.: overall progress
    }
    return out;
  }

  // Ease one side of key k, keeping the other side as it plays.
  function easeSide(p, k, isOut, eases) {
    var inType = p.keyInInterpolationType(k), outType = p.keyOutInterpolationType(k);
    var inEase = p.keyInTemporalEase(k), outEase = p.keyOutTemporalEase(k);
    if (p.keyTemporalContinuous(k)) p.setTemporalContinuousAtKey(k, false);
    if (isOut) {
      p.setTemporalEaseAtKey(k, inEase, eases);
      p.setInterpolationTypeAtKey(k, inType, BEZIER);
    } else {
      p.setTemporalEaseAtKey(k, eases, outEase);
      p.setInterpolationTypeAtKey(k, BEZIER, outType);
    }
  }

  // Ease the selected pairs. side: "both" | "out" | "in". Returns the number of pairs eased.
  function applyCurve(c, side) {
    var pairs = selectedPairs(), n = 0;
    if (!pairs.length) return 0;
    var e = toEases(c);
    app.beginUndoGroup("PFlow: Apply Curve");
    try {
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i].prop, a = pairs[i].key;
        try {
          var s = slopes(p, a);
          if (!s) continue;
          var outE = [], inE = [];
          for (var d = 0; d < s.length; d++) {
            outE.push(new KeyframeEase(e.outSpeed * s[d], e.outInfluence));
            inE.push(new KeyframeEase(e.inSpeed * s[d], e.inInfluence));
          }
          if (side !== "in") easeSide(p, a, true, outE);
          if (side !== "out") easeSide(p, a + 1, false, inE);
          n++;
        } catch (err) {
          // a property that refuses (locked layer, ...) is skipped; the others still get eased
        }
      }
    } finally {
      app.endUndoGroup();
    }
    return n;
  }

  // The curve of the first selected pair (measured on the dimension that moves most).
  function captureCurve() {
    var pairs = selectedPairs();
    if (!pairs.length) return null;
    var p = pairs[0].prop, a = pairs[0].key;
    if (p.keyOutInterpolationType(a) === HOLD) return null;
    var s = slopes(p, a);
    if (!s) return null;
    var d = 0, i;
    for (i = 1; i < s.length; i++) if (Math.abs(s[i]) > Math.abs(s[d])) d = i;
    if (Math.abs(s[d]) < 1e-12) return null;
    var o = p.keyOutTemporalEase(a), n = p.keyInTemporalEase(a + 1);
    var oe = o[d] || o[0], ne = n[d] || n[0];
    if (!oe || !ne) return null;
    return fromEases({ outInfluence: oe.influence, outSpeed: oe.speed / s[d], inInfluence: ne.influence, inSpeed: ne.speed / s[d] });
  }

  // ------------------------------------------------------------------ panel

  var MIN_W = 120, MAX_W = 900, MIN_H = 100, MAX_H = 800;

  function loadSize() {
    try {
      if (app.settings.haveSetting(SECTION, "graphSize")) {
        var v = JSON.parse(app.settings.getSetting(SECTION, "graphSize"));
        if (v && finite(v.w) && finite(v.h)) return [clamp(v.w, MIN_W, MAX_W), clamp(v.h, MIN_H, MAX_H)];
      }
    } catch (e) {}
    return [260, 280];
  }

  var ui = thisObj instanceof Panel ? thisObj : new Window("palette", "PFlow", undefined, { resizeable: true });
  ui.orientation = "column";
  ui.alignChildren = ["fill", "top"];
  ui.spacing = 6;
  ui.margins = 8;

  var user = loadUser();
  var working = BUILT_IN[2].curve.slice(0);
  var dragging = -1;       // 0: out handle, 1: in handle
  var refreshing = false;
  var PAD = 14;

  var graph = ui.add("group", undefined, undefined, { name: "graph" });
  var box = loadSize();                 // the graph's width and height, set by dragging its border
  graph.preferredSize = [box[0], box[1]];
  graph.alignment = ["left", "top"];
  graph.helpTip = "Drag the handles (Shift snaps to 0.05). Double-click resets to Linear.";

  function gsize() { return [box[0], box[1]]; }

  function setBox(w, h) {
    box = [clamp(Math.round(w), MIN_W, MAX_W), clamp(Math.round(h), MIN_H, MAX_H)];
    graph.preferredSize = [box[0], box[1]];
    try { ui.layout.layout(true); } catch (e) {}
    redraw();
  }

  function toScreen(x, v) {
    var s = gsize();
    return [PAD + (s[0] - 2 * PAD) * x, s[1] - PAD - (s[1] - 2 * PAD) * (v - VIEW_LO) / (VIEW_HI - VIEW_LO)];
  }
  function fromScreen(px, py) {
    var s = gsize();
    var x = (px - PAD) / (s[0] - 2 * PAD);
    var v = VIEW_LO + (s[1] - PAD - py) * (VIEW_HI - VIEW_LO) / (s[1] - 2 * PAD);
    return [x, v];
  }

  graph.onDraw = function () {
    var g = this.graphics, s = gsize();
    var grid = g.newPen(g.PenType.SOLID_COLOR, [0.5, 0.5, 0.5, 0.35], 1);
    var frame = g.newPen(g.PenType.SOLID_COLOR, [0.6, 0.6, 0.6, 0.8], 1);
    var arm = g.newPen(g.PenType.SOLID_COLOR, [0.75, 0.75, 0.75, 1], 1);
    var accent = g.newPen(g.PenType.SOLID_COLOR, [0.29, 0.56, 1, 1], 2.5);
    var dot = g.newBrush(g.BrushType.SOLID_COLOR, [0.95, 0.45, 0.2, 1]);
    var a, b, i, t;
    // 0 and 1 value guide lines and the unit box
    g.newPath();
    a = toScreen(0, 0); b = toScreen(1, 0); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    a = toScreen(0, 1); b = toScreen(1, 1); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    g.strokePath(grid);
    g.newPath();
    g.rectPath(0, 0, s[0], s[1]);
    g.strokePath(frame);
    var h1 = toScreen(working[0], working[1]), h2 = toScreen(working[2], working[3]);
    var k0 = toScreen(0, 0), k1 = toScreen(1, 1);
    g.newPath();
    g.moveTo(k0[0], k0[1]); g.lineTo(h1[0], h1[1]);
    g.moveTo(k1[0], k1[1]); g.lineTo(h2[0], h2[1]);
    g.strokePath(arm);
    g.newPath();
    for (i = 0; i <= 64; i++) {
      t = i / 64;
      var u = 1 - t;
      var x = 3 * u * u * t * working[0] + 3 * u * t * t * working[2] + t * t * t;
      var v = 3 * u * u * t * working[1] + 3 * u * t * t * working[3] + t * t * t;
      var q = toScreen(x, v);
      if (i === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]);
    }
    g.strokePath(accent);
    g.newPath(); g.ellipsePath(h1[0] - 5, h1[1] - 5, 10, 10); g.fillPath(dot);
    g.newPath(); g.ellipsePath(h2[0] - 5, h2[1] - 5, 10, 10); g.fillPath(dot);
  };

  function redraw() {
    try { graph.notify("onDraw"); } catch (e) {}
  }

  function setCurve(c, silent) {
    working = c;
    refreshing = true;
    values.text = curveText(c);
    refreshing = false;
    redraw();
    if (!silent && live.value) applyNow();
  }

  function moveHandle(which, e) {
    var p = fromScreen(e.clientX, e.clientY), x = p[0], v = p[1];
    if (e.shiftKey) { x = Math.round(x * 20) / 20; v = Math.round(v * 20) / 20; }
    var c = working.slice(0);
    if (which === 0) { c[0] = x; c[1] = v; } else { c[2] = x; c[3] = v; }
    c = sane(c);
    if (c) {
      working = c;
      refreshing = true;
      values.text = curveText(c);
      refreshing = false;
      redraw();
    }
  }

  graph.addEventListener("mousedown", function (e) {
    if (e.detail >= 2) { setCurve(BUILT_IN[0].curve.slice(0)); return; }
    var h1 = toScreen(working[0], working[1]), h2 = toScreen(working[2], working[3]);
    var d1 = Math.pow(e.clientX - h1[0], 2) + Math.pow(e.clientY - h1[1], 2);
    var d2 = Math.pow(e.clientX - h2[0], 2) + Math.pow(e.clientY - h2[1], 2);
    if (Math.min(d1, d2) > 22 * 22) return;
    dragging = d1 <= d2 ? 0 : 1;
    moveHandle(dragging, e);
  });
  graph.addEventListener("mousemove", function (e) {
    if (dragging >= 0) moveHandle(dragging, e);
  });
  graph.addEventListener("mouseup", function (e) {
    if (dragging < 0) return;
    moveHandle(dragging, e);
    dragging = -1;
    if (live.value) applyNow();
  });

  // Width and height of the graph.
  function sizeSlider(label, name, lo, hi, value, onSet) {
    var row = ui.add("group");
    row.alignChildren = ["fill", "center"];
    var t = row.add("statictext", undefined, label);
    t.preferredSize = [48, 20];
    var sl = row.add("slider", undefined, value, lo, hi, { name: name });
    sl.onChanging = function () { onSet(Math.round(sl.value)); };
    sl.onChange = function () {
      onSet(Math.round(sl.value));
      try { app.settings.saveSetting(SECTION, "graphSize", JSON.stringify({ w: box[0], h: box[1] })); } catch (e) {}
    };
    return sl;
  }
  sizeSlider("Width", "graphWidth", MIN_W, MAX_W, box[0], function (w) { setBox(w, box[1]); });
  sizeSlider("Height", "graphHeight", MIN_H, MAX_H, box[1], function (h) { setBox(box[0], h); });

  var valueRow = ui.add("group");
  valueRow.alignChildren = ["fill", "center"];
  valueRow.add("statictext", undefined, "x1,y1,x2,y2");
  var values = valueRow.add("edittext", undefined, "", { name: "values" });
  values.helpTip = "Four numbers; you can paste cubic-bezier(0.4, 0, 0.2, 1)";
  values.onChange = function () {
    if (refreshing) return;
    var c = parseCurve(values.text);
    if (c) setCurve(c); else { values.text = curveText(working); status.text = "Type four numbers"; }
  };

  var sideRow = ui.add("group");
  sideRow.add("statictext", undefined, "Apply to");
  var side = sideRow.add("dropdownlist", undefined, ["Both sides", "Out (first key)", "In (second key)"], { name: "side" });
  side.selection = 0;
  var live = sideRow.add("checkbox", undefined, "Live", { name: "live" });
  live.helpTip = "Re-apply the curve whenever you let go of a handle or pick a preset";

  var actions = ui.add("group");
  var applyButton = actions.add("button", undefined, "Apply", { name: "apply" });
  var fromKeys = actions.add("button", undefined, "From Keys", { name: "fromKeys" });
  var flipButton = actions.add("button", undefined, "Flip", { name: "flip" });
  flipButton.helpTip = "Reverse the curve (as if the animation ran backwards)";

  var list = ui.add("listbox", undefined, [], { name: "presets" });
  list.preferredSize = [240, 130];
  list.helpTip = "Click a preset to load it and apply it to the selected keyframes";

  var nameRow = ui.add("group");
  nameRow.alignChildren = ["fill", "center"];
  var nameField = nameRow.add("edittext", undefined, "", { name: "name" });
  nameField.helpTip = "Preset name";
  var saveButton = nameRow.add("button", undefined, "Save", { name: "save" });
  var edits = ui.add("group");
  var renameButton = edits.add("button", undefined, "Rename", { name: "rename" });
  var deleteButton = edits.add("button", undefined, "Delete", { name: "delete" });
  var status = ui.add("statictext", undefined, "", { name: "status" });
  status.alignment = ["fill", "top"];

  function sideKey() {
    var i = side.selection ? side.selection.index : 0;
    return i === 1 ? "out" : (i === 2 ? "in" : "both");
  }

  function applyNow() {
    var n = applyCurve(working, sideKey());
    status.text = n > 0 ? "Eased " + n + " keyframe pair(s)" : "Select two or more neighbouring keyframes of a property";
    return n;
  }

  function allPresets() { return BUILT_IN.concat(user); }

  function selectedUser() {
    var item = list.selection;
    if (!item) return null;
    var i = find(user, item.text);
    return i < 0 ? null : user[i];
  }

  function refresh(select) {
    refreshing = true;
    list.removeAll();
    var all = allPresets();
    for (var i = 0; i < all.length; i++) list.add("item", all[i].name);
    if (select) {
      var j = find(all, select);
      if (j >= 0) list.selection = j;
    }
    refreshing = false;
  }

  list.onChange = function () {
    if (refreshing || !list.selection) return;
    var all = allPresets(), i = find(all, list.selection.text);
    if (i < 0) return;
    nameField.text = find(user, all[i].name) >= 0 ? all[i].name : "";
    setCurve(all[i].curve.slice(0), true);
    applyNow();
  };

  applyButton.onClick = function () { applyNow(); };

  fromKeys.onClick = function () {
    var c = captureCurve();
    if (!c) { status.text = "Select two neighbouring keyframes whose value changes"; return; }
    setCurve(c, true);
    status.text = "Read the curve of the selected keyframes";
  };

  flipButton.onClick = function () { setCurve(mirrored(working)); };

  saveButton.onClick = function () {
    var name = cleanName(nameField.text);
    if (!name) { status.text = "Type a name for the preset first"; return; }
    if (find(BUILT_IN, name) >= 0) { status.text = "“" + name + "” is built in; choose another name"; return; }
    var i = find(user, name), entry = { name: name, curve: working.slice(0) };
    if (i >= 0) user[i] = entry; else user.push(entry);
    try { saveUser(user); } catch (e) { status.text = "Could not save: " + e.message; return; }
    refresh(name);
    status.text = "Saved “" + name + "”";
  };

  renameButton.onClick = function () {
    var p = selectedUser(), name = cleanName(nameField.text);
    if (!p) { status.text = "Select one of your own presets first"; return; }
    if (!name) { status.text = "Type the new name first"; return; }
    var other = find(user, name);
    if (find(BUILT_IN, name) >= 0 || (other >= 0 && user[other] !== p)) { status.text = "A preset named “" + name + "” exists"; return; }
    p.name = name;
    saveUser(user);
    refresh(name);
    status.text = "Renamed to “" + name + "”";
  };

  deleteButton.onClick = function () {
    var p = selectedUser();
    if (!p) { status.text = "Select one of your own presets first"; return; }
    user.splice(find(user, p.name), 1);
    saveUser(user);
    refresh(null);
    nameField.text = "";
    status.text = "Deleted “" + p.name + "”";
  };

  refresh(null);
  setCurve(working, true);
  status.text = "Select keyframes, shape the curve, press Apply";
  if (ui instanceof Window) ui.show(); else ui.layout.layout(true);
})(this);
