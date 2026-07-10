// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { prepareEmailHtml } from "./email-render";

describe("prepareEmailHtml — hidden preheader stripping", () => {
  test("strips a leading display:none preheader", () => {
    const html = `<div style="display:none">Your weekly digest is here plus more inside</div><p>Hello reader</p>`;
    const out = prepareEmailHtml(html);
    expect(out).not.toContain("weekly digest");
    expect(out).toContain("Hello reader");
  });

  test("strips a leading font-size:1px/max-height:0 preheader", () => {
    const html = `<div style="font-size:1px;line-height:1px;max-height:0;color:transparent">preview text here</div><h2>Real title</h2>`;
    const out = prepareEmailHtml(html);
    expect(out).not.toContain("preview text here");
    expect(out).toContain("Real title");
  });

  test("strips a leading invisible-character padding run", () => {
    const pad = "‌ ".repeat(40);
    const html = `<div>${pad}</div><p>Story begins</p>`;
    const out = prepareEmailHtml(html);
    expect(out).not.toContain("‌");
    expect(out).toContain("Story begins");
  });

  test("keeps hidden elements that appear after visible content", () => {
    const html = `<p>Intro paragraph text</p><div style="display:none">mid-body hidden analytics blob</div><p>More</p>`;
    const out = prepareEmailHtml(html);
    expect(out).toContain("mid-body hidden analytics blob");
  });

  test("scans past tracking pixels without treating them as content", () => {
    const html = `<img src="https://t.example/px.gif" width="1" height="1"><div style="display:none">preview snippet</div><p>Body</p>`;
    const out = prepareEmailHtml(html);
    expect(out).not.toContain("preview snippet");
    expect(out).toContain("px.gif");
    expect(out).toContain("Body");
  });

  test("keeps a small &nbsp; spacer div", () => {
    const html = `<div> </div><p>Content</p>`;
    const out = prepareEmailHtml(html);
    expect(out).toMatch(/<div>(&nbsp;| )<\/div>/);
  });
});

describe("prepareEmailHtml — duplicate-subject stripping", () => {
  test("removes a leading block that equals the subject", () => {
    const html = `<table><tr><td><h1>Fund II — LP Update &amp; Timing</h1><p>Dear reader, the details follow in this long body text.</p></td></tr></table>`;
    const out = prepareEmailHtml(html, { subject: "Fund II — LP Update & Timing" });
    expect(out).not.toContain("<h1>");
    expect(out).toContain("Dear reader");
  });

  test("removes a title the subject extends with a suffix", () => {
    const html = `<h1>How the best PMs run discovery</h1><p>This week: a deep dive with plenty of body text following.</p>`;
    const out = prepareEmailHtml(html, {
      subject: "How the best PMs run discovery (Lenny's Newsletter)",
    });
    expect(out).not.toContain("<h1>");
    expect(out).toContain("deep dive");
  });

  test("keeps a leading heading that differs from the subject", () => {
    const html = `<h1>A completely different headline</h1><p>Body text goes on for a while here.</p>`;
    const out = prepareEmailHtml(html, { subject: "March portfolio review" });
    expect(out).toContain("A completely different headline");
  });

  test("never empties a message whose whole body is the subject", () => {
    const html = `<p>Quick question</p>`;
    const out = prepareEmailHtml(html, { subject: "Quick question" });
    expect(out).toContain("Quick question");
  });

  test("ignores the subject-echo pass when no subject is given", () => {
    const html = `<h1>Quarterly update</h1><p>Numbers below and more commentary text.</p>`;
    const out = prepareEmailHtml(html);
    expect(out).toContain("Quarterly update");
  });

  test("matches through re:/fwd: prefixes and emoji noise", () => {
    const html = `<div><strong>🚀 Launch day recap</strong></div><p>Full recap with plenty of detail in the body, links to the livestream, photos, and a thank-you to everyone who joined us.</p>`;
    const out = prepareEmailHtml(html, { subject: "Re: Launch day recap" });
    expect(out).not.toContain("Launch day recap</strong>");
    expect(out).toContain("Full recap");
  });
});

describe("prepareEmailHtml — class-hidden preheaders (email's own <style>)", () => {
  test("scans past a class-hidden preheader to strip later hidden blocks and the subject echo", () => {
    const html = `<style>.preheader{display:none !important}</style>
<div class="preheader">This week: a deep dive on discovery habits</div>
<div style="display:none;max-height:0">inline hidden preview padding</div>
<h1>How the best PMs run discovery</h1>
<p>Continuous discovery is not a phase, it is a weekly habit — playbooks from PMs at Figma, Linear, and Notion follow below.</p>`;
    const out = prepareEmailHtml(html, {
      subject: "How the best PMs run discovery (Lenny's Newsletter)",
    });
    // class-hidden div stays (its own kept CSS hides it) …
    expect(out).toContain(`class="preheader"`);
    // … but it must not stop the scan: the inline-hidden block and the
    // duplicate-subject hero both go.
    expect(out).not.toContain("inline hidden preview padding");
    expect(out).not.toContain("<h1>");
    expect(out).toContain("weekly habit");
  });

  test("hiding inside @media does not count as hidden", () => {
    const html = `<style>@media (max-width:600px){.desktop-only{display:none}}</style>
<div class="desktop-only">Wide-screen headline</div>
<p>Body text that follows the headline with plenty of content.</p>`;
    const out = prepareEmailHtml(html, { subject: "Wide-screen headline" });
    // The div is visible at desktop widths, so it's real content — the
    // subject-echo pass may remove it as a duplicate, but the preheader pass
    // must not treat it as invisible. Here it duplicates the subject → gone.
    expect(out).not.toContain("Wide-screen headline");
    expect(out).toContain("Body text");
  });
});

describe("prepareEmailHtml — structure preservation", () => {
  test("keeps <style> hoisted into head by the parser", () => {
    const html = `<style>.preheader{display:none}</style><div class="preheader">preview</div><p>Body</p>`;
    const out = prepareEmailHtml(html);
    expect(out).toContain(".preheader{display:none}");
    expect(out).toContain(`class="preheader"`);
  });

  test("passes ordinary content through unchanged", () => {
    const html = `<table width="600"><tr><td><p>Plain newsletter paragraph.</p></td></tr></table>`;
    const out = prepareEmailHtml(html);
    expect(out).toContain("Plain newsletter paragraph.");
    expect(out).toContain(`width="600"`);
  });
});
