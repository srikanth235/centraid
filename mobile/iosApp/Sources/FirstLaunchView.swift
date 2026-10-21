import SwiftUI

import CentraidShared

/// THE FIRST-LAUNCH GATE: what a device that holds no vault opens onto, in
/// place of Home.
///
/// **A fresh install used to land on Home** — "No vault yet" over a grid that
/// could only skeleton — with onboarding two taps away behind the vault chip.
/// The vault is founded on this phone, so the first thing the app owes a
/// member is the way to make one (`docs/recovery/pairing.md`'s "Founding").
///
/// ## Three paper slips, because the model is the unfamiliar part
///
/// The apps on the phone, an assistant that runs there too, and encrypted
/// backups to systems the member owns: three claims, none of which needs the
/// 24 words to be understood (the words screen explains itself when it comes).
/// So the gate is a small deck of three slips — the apps, the assistant, the
/// backups — each a sentence over a picture drawn from the system's own parts
/// (the real app marks, a question and its answer, `--net` for the one thing
/// that leaves the device). The
/// slip is the paper metaphor of DESIGN.md's surfaces: raised paper, darker
/// than the page in light. No feature tour — the apps are shown as one
/// house, never explained one by one.
///
/// Next flings the top slip away (so does a swipe left, anywhere on the deck;
/// a swipe right brings the last one back); the slips behind are the count of
/// what is left. Restore is on every slip, and Skip jumps to the
/// last one: a member with their words in hand is never made to sit through
/// the model.
///
/// ## Nothing here decides anything
///
/// Whether this screen is up is `ShellModel.holdsNoVault`, the shared shelf's
/// answer; what each door does is the shell's existing entry point —
/// `makeVault()` opens `words.make`, which decides whether this phone mints
/// words, makes from a seed it holds, or must restore first, and
/// `openRestore()` opens `words.enter`. Both present the root words sheet over
/// this screen, so **cancelling out of either lands back here**, and the gate
/// goes only when a vault is held — the shelf says so, and Home takes its
/// place behind the sheet's last screen.
struct FirstLaunchView: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0
    @State private var drag: CGFloat = 0

    private static let last = 2
    private static let slipHeight: CGFloat = 420

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer(minLength: 0)
                // SKIP LEAVES ON THE LAST PAGE, which has nowhere further to
                // skip to; its place is kept so the header never reflows.
                if page < Self.last {
                    KitLink(label: HomeWords.shared.FIRST_LAUNCH_SKIP, identifier: "first-launch-skip") {
                        page = Self.last
                    }
                } else {
                    Color.clear
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)

            Spacer(minLength: 0)

            ZStack {
                slip(0, title: HomeWords.shared.FIRST_LAUNCH_HOUSE_TITLE,
                     sentence: HomeWords.shared.FIRST_LAUNCH_HOUSE_BODY, id: "house") { HouseScene() }
                slip(1, title: HomeWords.shared.FIRST_LAUNCH_ASSISTANT_TITLE,
                     sentence: HomeWords.shared.FIRST_LAUNCH_ASSISTANT_BODY, id: "assistant") { AssistantScene() }
                slip(2, title: HomeWords.shared.FIRST_LAUNCH_BACKUP_TITLE,
                     sentence: HomeWords.shared.FIRST_LAUNCH_BACKUP_BODY, id: "backup") { CopyScene() }
            }
            .frame(maxWidth: 300)
            .frame(height: Self.slipHeight)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .animation(reduceMotion ? nil : FirstLaunchMotion.entry, value: page)
            // THE WHOLE BAND IS THE SURFACE, not only the slip under the finger:
            // a swipe that starts on the paper's margin still turns the deck.
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .gesture(deckSwipe)

            Spacer(minLength: 0)

            // THE SAME TWO CONTROLS THE WORDS SCREENS DRAW: ink for the act,
            // a quiet link for the way back. One ink element per view, so
            // "Next" and "Make a vault" are the same button changing its verb.
            WordsControls(
                primary: page < Self.last ? HomeWords.shared.FIRST_LAUNCH_NEXT : HomeWords.shared.FIRST_LAUNCH_MAKE,
                primaryEnabled: true,
                secondary: HomeWords.shared.FIRST_LAUNCH_RESTORE,
                prefix: "first-launch",
                onPrimary: {
                    if page < Self.last { page += 1 } else { shell.makeVault() }
                },
                onSecondary: { shell.openRestore() }
            )
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("first-launch")
    }

    /// Left throws the top slip; right brings the last thrown one back. The
    /// last slip stays put when thrown — it carries the way in — but can be
    /// swiped back from.
    private var deckSwipe: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                if page < Self.last { drag = min(0, value.translation.width) }
            }
            .onEnded { value in
                let forward = value.translation.width < -80 && page < Self.last
                let back = value.translation.width > 80 && page > 0
                withAnimation(reduceMotion ? nil : FirstLaunchMotion.entry) {
                    drag = 0
                    if forward { page += 1 } else if back { page -= 1 }
                }
            }
    }

    /// One slip, placed by how far it is from the top of the deck: thrown
    /// (already read) it leaves up and to the left; the top one follows the
    /// finger; the two behind step down and in, tilted a little apart.
    private func slip<Scene: View>(
        _ index: Int, title: String, sentence: String, id: String,
        @ViewBuilder scene: @escaping () -> Scene
    ) -> some View {
        let rel = index - page
        let tilt = [-2.0, 1.5, -1.0][index]
        let depth = CGFloat(min(max(rel, 0), 2))
        return FirstLaunchSlip(title: title, sentence: sentence, id: id, scene: scene)
            .rotationEffect(.degrees(rel < 0 ? -18 : (rel == 0 ? tilt + Double(drag / 24) : tilt)))
            .scaleEffect(rel < 0 ? 1 : 1 - depth * 0.04)
            .offset(x: rel < 0 ? -520 : (rel == 0 ? drag : 0),
                    y: rel < 0 ? -30 : depth * 14)
            .opacity(rel < 0 ? 0 : 1)
            .zIndex(Double(10 - rel))
            .allowsHitTesting(rel == 0)
            .accessibilityHidden(rel != 0)
    }
}

/// DESIGN.md invariant 5, lowered once for this screen: entry and settle at
/// 280ms on the entry curve. Nothing here bounces, loops or parallaxes;
/// reduced motion drops every movement (the slips change place at once).
private enum FirstLaunchMotion {
    static let entry = Animation.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.28)
}

/// One slip: raised paper (`bgElev`, darker than the page in light), the
/// picture at the top and one title and one sentence at the foot.
private struct FirstLaunchSlip<Scene: View>: View {
    let title: String
    let sentence: String
    let id: String
    @ViewBuilder let scene: () -> Scene
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            scene()
                .frame(maxWidth: .infinity)
                .padding(.top, 10)
                .accessibilityHidden(true)
            Spacer(minLength: 16)
            Text(title)
                .centraidType("display")
                .foregroundStyle(Theme.color("text", scheme))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(sentence)
                .centraidType("body")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                .fill(Theme.color("bgElev", scheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                .strokeBorder(Theme.color("line", scheme), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("first-launch-\(id)")
    }
}

/// EVERY APP'S MARK AS ONE HOUSE: rooms in one place, not separate products.
/// The marks are Home's own roster (`FirstLaunch.APPS`, #1129), so an app that
/// gets a tile is in the house too; five to a row at 40pt is the same width the
/// grid always took, and fits the narrowest phone's slip.
private struct HouseScene: View {
    private static let apps = FirstLaunch.shared.APPS

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(40), spacing: 8), count: 5),
                  spacing: 12) {
            ForEach(Self.apps, id: \.self) { AppMark(appID: $0, size: 40) }
        }
        .padding(.top, 18)
        .frame(height: 150, alignment: .top)
    }
}

/// A QUESTION AND ITS ANSWER, DRAWN FROM THE ASSISTANT'S OWN PARTS: the
/// member's line on the right, the assistant's on the left with the app it read
/// from — a real mark, so the picture says "your things" and not "a chatbot".
/// Bars stand in for words; nothing here reads as a particular question.
private struct AssistantScene: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Spacer(minLength: 40)
                bubble(bars: [92, 58], fill: "bgSunken", stroke: "line")
            }
            HStack(alignment: .top, spacing: 8) {
                bubble(bars: [112, 96, 64], fill: "bg", stroke: "lineStrong")
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                AppMark(appID: "agenda", size: 22)
                Capsule()
                    .fill(Theme.color("line", scheme))
                    .frame(width: 70, height: 5)
            }
            .padding(.leading, 6)
        }
        .padding(.top, 18)
        .frame(height: 150, alignment: .top)
    }

    private func bubble(bars: [CGFloat], fill: String, stroke: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(bars.enumerated()), id: \.offset) { _, width in
                Capsule()
                    .fill(Theme.color("text", scheme))
                    .frame(width: width, height: 5)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .fill(Theme.color(fill, scheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .strokeBorder(Theme.color(stroke, scheme), lineWidth: 1)
        )
    }
}

/// THE ONE THING THAT LEAVES THE DEVICE, drawn in the colour that means
/// exactly that: a `--net` rule from the phone to a laptop, and a sealed copy
/// of the vault on the other machine's screen while the original stays home.
private struct CopyScene: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                    .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: 1.5)
                    .frame(width: 62, height: 110)
                AppMark(appID: "locker", size: 32)
            }
            Line()
                .stroke(Theme.color("net", scheme),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [4, 6]))
                .frame(height: 2)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 10)
            VStack(spacing: 3) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: 1.5)
                        .frame(width: 100, height: 66)
                    AppMark(appID: "locker", size: 32)
                }
                Capsule()
                    .fill(Theme.color("lineStrong", scheme))
                    .frame(width: 124, height: 5)
            }
        }
        .frame(height: 150)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}

/// THE FRAME BEFORE THE SHELF HAS READ ITS DIRECTORY (`ShellModel.holdsNoVault`
/// is nil): the page and nothing on it, so neither the gate nor Home is drawn
/// for an answer that has not arrived.
struct BarePaper: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Theme.color("bg", scheme).ignoresSafeArea()
    }
}
