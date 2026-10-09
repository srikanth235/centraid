import SwiftUI

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
/// No account, the phone holds everything, 24 words are the key, and the
/// laptop keeps a copy it cannot open: a member who has not met those ideas
/// reads the words screen as a formality. So the gate is a small deck of
/// three slips — the house, the key, the copy — each a sentence over a
/// picture drawn from the system's own parts (the real app marks, the shape
/// of the word grid, `--net` for the one thing that leaves the device). The
/// slip is the paper metaphor of DESIGN.md's surfaces: raised paper, darker
/// than the page in light. No feature tour — the apps are shown as one
/// house, never explained one by one.
///
/// Next flings the top slip away (so does a swipe); the slips behind are the
/// count of what is left. Restore is on every slip, and Skip jumps to the
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
                Button {
                    page = Self.last
                } label: {
                    Text(ShellWords.firstLaunchSkip)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .frame(minWidth: CentraidGeometry.targetMinCoarse,
                               minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(page < Self.last ? 1 : 0)
                .disabled(page == Self.last)
                .accessibilityHidden(page == Self.last)
                .accessibilityIdentifier("first-launch-skip")
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)

            Spacer(minLength: 0)

            ZStack {
                slip(0, title: ShellWords.firstLaunchHouseTitle,
                     sentence: ShellWords.firstLaunchHouseBody, id: "house") { HouseScene() }
                slip(1, title: ShellWords.firstLaunchKeyTitle,
                     sentence: ShellWords.firstLaunchKeyBody, id: "key") { KeyScene() }
                slip(2, title: ShellWords.firstLaunchCopyTitle,
                     sentence: ShellWords.firstLaunchCopyBody, id: "copy") { CopyScene() }
            }
            .frame(maxWidth: 300)
            .frame(height: Self.slipHeight)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .animation(reduceMotion ? nil : FirstLaunchMotion.entry, value: page)

            Spacer(minLength: 0)

            // THE SAME TWO CONTROLS THE WORDS SCREENS DRAW: ink for the act,
            // a quiet link for the way back. One ink element per view, so
            // "Next" and "Make a vault" are the same button changing its verb.
            WordsControls(
                primary: page < Self.last ? ShellWords.firstLaunchNext : ShellWords.firstLaunchMake,
                primaryEnabled: true,
                secondary: ShellWords.firstLaunchRestore,
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
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        if page < Self.last { drag = min(0, value.translation.width) }
                    }
                    .onEnded { value in
                        // A fling or a long enough drag throws the slip; the last one
                        // stays, because it carries the way in.
                        let thrown = value.translation.width < -80 && page < Self.last
                        withAnimation(reduceMotion ? nil : FirstLaunchMotion.entry) {
                            drag = 0
                            if thrown { page += 1 }
                        }
                    }
            )
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

/// THE EIGHT APP MARKS AS ONE HOUSE: rooms in one place, not eight products.
private struct HouseScene: View {
    private static let apps = ["photos", "docs", "notes", "agenda", "tasks", "people", "tally", "locker"]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(52), spacing: 8), count: 4),
                  spacing: 12) {
            ForEach(Self.apps, id: \.self) { AppMark(appID: $0, size: 52) }
        }
        .padding(.top, 18)
        .frame(height: 150, alignment: .top)
    }
}

/// TWENTY-FOUR NUMBERED SLOTS AND NO WORD IN ANY OF THEM: the shape of what
/// the next screens ask for. Three are ringed — the three the words flow asks
/// back.
private struct KeyScene: View {
    @Environment(\.colorScheme) private var scheme

    private static let askedBack: Set<Int> = [2, 13, 21]
    /// Word-ish lengths for the ink bars, so the grid reads as words.
    private static let lengths: [CGFloat] = [14, 9, 16, 11, 8, 15, 12, 10, 17, 9, 14, 11,
                                             15, 8, 12, 16, 10, 14, 9, 15, 11, 16, 8, 12]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4),
                  spacing: 6) {
            ForEach(0..<24, id: \.self) { index in
                let ringed = Self.askedBack.contains(index)
                HStack(spacing: 4) {
                    Text("\(index + 1)")
                        .centraidType("mono")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("textFaint", scheme))
                    Capsule()
                        .fill(Theme.color("text", scheme))
                        .frame(width: Self.lengths[index], height: 4)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .frame(height: 26)
                .background(
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                        .strokeBorder(Theme.color(ringed ? "text" : "line", scheme),
                                      lineWidth: ringed ? 1.5 : 1)
                )
            }
        }
        .frame(height: 170, alignment: .top)
    }
}

/// THE ONE THING THAT LEAVES THE DEVICE, drawn in the colour that means
/// exactly that: a `--net` rule from the phone to a laptop, and a sealed copy
/// of the vault on the laptop's screen while the original stays home.
private struct CopyScene: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 14)
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
