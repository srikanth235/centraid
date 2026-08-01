// #686: illustration art, exempt from token contract
// The onboarding hero: "it lives at home."
//
// A house whose front door is the gateway mark, four blueprint apps as lit
// windows (Docs, Photos, Agenda, Tasks), this phone and a laptop paired in with
// green ticks, and a struck-through cloud — nobody's servers in the picture.
// It portrays the product rather than any one step, so the same art carries all
// three onboarding steps.
//
// Motion: the intro plays ONCE on mount and settles. Only the sync dashes keep
// marching, because this art sits above a form the person is reading and typing
// into — a looping cartoon would compete with the pairing code for attention.

import React, { useEffect } from "react";
import {
  createAnimatedComponent,
  Easing,
  interpolate,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

const AnimatedG = createAnimatedComponent(G);
const AnimatedPath = createAnimatedComponent(Path);

/**
 * Natural size of {@link HomeArt}, in points — what it draws at when a screen
 * has room to spare. Exported so callers cap the art at its own proportions
 * instead of keeping a second copy of them.
 */
export const HOME_ART = { width: 350, height: 196 } as const;

/** Length of the roof path, for the draw-on stroke. */
const ROOF_LEN = 190;
/** Length of the cloud's strike-through, for its draw-on stroke. */
const STRIKE_LEN = 54;
/** Sync-dash pattern; the ants march by one full period. */
const ANT_PERIOD = 12;

/** Dim state of a window before its device pairs. */
const WINDOW_DIM = 0.45;

export function HomeArt({
  width,
  height,
}: {
  width: number;
  height: number;
}): React.JSX.Element {
  // Fit inside BOTH axes at one uniform scale: an SVG sized on height alone
  // overflows sideways on a 320pt-wide device.
  const scale = Math.max(
    0,
    Math.min(width / HOME_ART.width, height / HOME_ART.height)
  );

  const reduceMotion = useReducedMotion();
  /** 0 → 1 once on mount: the whole arrival sequence. */
  const intro = useSharedValue(reduceMotion ? 1 : 0);
  /** 0 → 1 forever: marching ants on the sync links. */
  const ants = useSharedValue(0);

  // Driving a mount animation means assigning shared values from an effect —
  // reanimated's documented pattern, and the only place the "once, on mount"
  // timing can come from. react-compiler reads the assignment as mutating a
  // hook result; a SharedValue is a mutable box by design, so the warning does
  // not apply. Not a deferral: there is nothing here to un-mute later.
  /* oxlint-disable react/react-compiler -- #643 SharedValue.value assignment is reanimated's mount-animation API, not a React state mutation */
  useEffect(() => {
    if (reduceMotion) {
      intro.value = 1;
      return;
    }
    intro.value = withDelay(
      120,
      withTiming(1, { duration: 2600, easing: Easing.out(Easing.cubic) })
    );
    ants.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.linear }),
      -1
    );
  }, [reduceMotion, intro, ants]);
  /* oxlint-enable react/react-compiler */

  // Each element reads one window of the single intro clock, so the beats stay
  // in a fixed order however long the animation runs: roof → house → devices →
  // links → ticks → windows → the cloud being ruled out.
  const roof = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(
      intro.value,
      [0, 0.34],
      [ROOF_LEN, 0],
      "clamp"
    ),
  }));
  const house = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0, 0.12], [0, 1], "clamp"),
  }));
  const phone = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.22, 0.4], [0, 1], "clamp"),
  }));
  const laptop = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.28, 0.46], [0, 1], "clamp"),
  }));
  const linkLeft = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.44, 0.56], [0, 1], "clamp"),
    strokeDashoffset: -ANT_PERIOD * ants.value,
  }));
  const linkRight = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.48, 0.6], [0, 1], "clamp"),
    strokeDashoffset: -ANT_PERIOD * ants.value,
  }));
  const tickLeft = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.6, 0.72], [0, 1], "clamp"),
    scale: interpolate(intro.value, [0.6, 0.78], [0.4, 1], "clamp"),
  }));
  const tickRight = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.64, 0.76], [0, 1], "clamp"),
    scale: interpolate(intro.value, [0.64, 0.82], [0.4, 1], "clamp"),
  }));
  const windows = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.68, 0.9], [WINDOW_DIM, 1], "clamp"),
  }));
  const cloud = useAnimatedProps(() => ({
    opacity: interpolate(intro.value, [0.8, 0.92], [0, 1], "clamp"),
  }));
  const strike = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(
      intro.value,
      [0.86, 1],
      [STRIKE_LEN, 0],
      "clamp"
    ),
  }));

  return (
    <Svg
      width={HOME_ART.width * scale}
      height={HOME_ART.height * scale}
      viewBox={`0 0 ${HOME_ART.width} ${HOME_ART.height}`}
      fill="none"
    >
      <Defs>
        <RadialGradient id="homeGlow" cx="50%" cy="46%" r="55%">
          <Stop offset="0%" stopColor="#33B8A1" stopOpacity={0.14} />
          <Stop offset="100%" stopColor="#33B8A1" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="homeDoor" cx="35%" cy="28%" r="85%">
          <Stop offset="0%" stopColor="#6FE8CE" />
          <Stop offset="55%" stopColor="#22A78F" />
          <Stop offset="100%" stopColor="#0E7B6C" />
        </RadialGradient>
        <LinearGradient id="homeWall" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#ffffff" stopOpacity={0.075} />
          <Stop offset="100%" stopColor="#ffffff" stopOpacity={0.035} />
        </LinearGradient>
      </Defs>

      <Ellipse cx={175} cy={102} rx={150} ry={86} fill="url(#homeGlow)" />

      <AnimatedG animatedProps={house}>
        {/* something to stand on */}
        <Line
          x1={66}
          y1={170}
          x2={284}
          y2={170}
          stroke="rgba(255,255,255,.12)"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <Rect
          x={116}
          y={88}
          width={118}
          height={82}
          rx={10}
          fill="url(#homeWall)"
          stroke="rgba(51,184,161,.5)"
          strokeWidth={1.7}
        />

        {/* The blueprint apps as windows — they warm from dim once paired. */}
        <AnimatedG animatedProps={windows}>
          {/* Docs: a page of text */}
          <Rect x={127} y={98} width={17} height={20} rx={3} fill="#4E68DD" />
          <Rect
            x={130.5}
            y={103}
            width={10}
            height={1.8}
            rx={0.9}
            fill="rgba(255,255,255,.9)"
          />
          <Rect
            x={130.5}
            y={107}
            width={10}
            height={1.8}
            rx={0.9}
            fill="rgba(255,255,255,.65)"
          />
          <Rect
            x={130.5}
            y={111}
            width={6.5}
            height={1.8}
            rx={0.9}
            fill="rgba(255,255,255,.45)"
          />

          {/* Photos: a framed picture */}
          <Rect x={205} y={98} width={20} height={20} rx={4} fill="#E89A3C" />
          <Path
            d="M205 112 l 6 -5.5 l 4.5 4 l 3.5 -3 l 6 5 l 0 1.5 a4 4 0 0 1 -4 4 l -12 0 a4 4 0 0 1 -4 -4 z"
            fill="rgba(0,0,0,.32)"
          />
          <Circle cx={219.5} cy={103.5} r={2} fill="#fff" opacity={0.95} />

          {/* Agenda: a month grid */}
          <Rect
            x={127}
            y={142}
            width={19}
            height={19}
            rx={3.5}
            fill="#E55772"
          />
          <Rect
            x={127}
            y={142}
            width={19}
            height={5.5}
            rx={3.5}
            fill="rgba(0,0,0,.3)"
          />
          <Circle cx={132.5} cy={152} r={1.5} fill="#fff" opacity={0.9} />
          <Circle cx={137} cy={152} r={1.5} fill="#fff" opacity={0.55} />
          <Circle cx={141.5} cy={152} r={1.5} fill="#fff" opacity={0.55} />
          <Circle cx={132.5} cy={156.5} r={1.5} fill="#fff" opacity={0.55} />
          <Circle cx={137} cy={156.5} r={1.5} fill="#fff" opacity={0.9} />

          {/* Tasks: a checklist, one done */}
          <Rect
            x={206}
            y={142}
            width={19}
            height={19}
            rx={3.5}
            fill="#5C8A4E"
          />
          <Path
            d="M209.5 147.5 l 1.8 2 l 3.2 -3.5"
            stroke="#fff"
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Rect
            x={216.5}
            y={146.5}
            width={6}
            height={1.8}
            rx={0.9}
            fill="rgba(255,255,255,.85)"
          />
          <Rect
            x={209.5}
            y={153.5}
            width={3.5}
            height={3.5}
            rx={1}
            fill="none"
            stroke="#fff"
            strokeWidth={1.2}
            opacity={0.75}
          />
          <Rect
            x={216.5}
            y={154}
            width={6}
            height={1.8}
            rx={0.9}
            fill="rgba(255,255,255,.5)"
          />
        </AnimatedG>

        {/* The gateway is the front door. */}
        <Rect
          x={157}
          y={112}
          width={36}
          height={36}
          rx={11}
          fill="url(#homeDoor)"
        />
        <Circle
          cx={175}
          cy={130}
          r={10.2}
          stroke="#fff"
          strokeWidth={2.9}
          fill="none"
        />
        <Circle cx={175} cy={130} r={3.2} fill="#fff" />
      </AnimatedG>

      {/* The roof draws itself on arrival. */}
      <AnimatedPath
        d="M104 88 L 175 40 L 246 88"
        stroke="#33B8A1"
        strokeWidth={4.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        strokeDasharray={ROOF_LEN}
        animatedProps={roof}
      />

      {/* This phone. */}
      <AnimatedG animatedProps={phone}>
        <Rect
          x={30}
          y={118}
          width={34}
          height={58}
          rx={8}
          fill="#151b22"
          stroke="rgba(255,255,255,.38)"
          strokeWidth={1.8}
        />
        <Rect
          x={34}
          y={126}
          width={26}
          height={38}
          rx={3.5}
          fill="rgba(51,184,161,.16)"
        />
        <Rect
          x={42}
          y={121}
          width={10}
          height={3}
          rx={1.5}
          fill="rgba(255,255,255,.35)"
        />
      </AnimatedG>
      <AnimatedPath
        d="M66 142 C 84 138, 98 132, 114 126"
        stroke="#33B8A1"
        strokeWidth={2.1}
        fill="none"
        strokeLinecap="round"
        strokeDasharray="5 7"
        animatedProps={linkLeft}
      />
      <AnimatedG originX={63} originY={112} animatedProps={tickLeft}>
        <Circle
          cx={63}
          cy={112}
          r={9.5}
          fill="#22A78F"
          stroke="#0b0e13"
          strokeWidth={2.5}
        />
        <Path
          d="M58 112 l 3.2 3.6 l 6.6 -7.2"
          stroke="#fff"
          strokeWidth={2.3}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </AnimatedG>

      {/* And the laptop already in the house. */}
      <AnimatedG animatedProps={laptop}>
        <Rect
          x={282}
          y={126}
          width={52}
          height={34}
          rx={4.5}
          fill="#151b22"
          stroke="rgba(255,255,255,.38)"
          strokeWidth={1.8}
        />
        <Rect
          x={286}
          y={130}
          width={44}
          height={26}
          rx={2.5}
          fill="rgba(51,184,161,.16)"
        />
        <Rect
          x={276}
          y={162}
          width={64}
          height={5}
          rx={2.5}
          fill="rgba(255,255,255,.28)"
        />
      </AnimatedG>
      <AnimatedPath
        d="M280 138 C 264 134, 252 130, 236 124"
        stroke="#33B8A1"
        strokeWidth={2.1}
        fill="none"
        strokeLinecap="round"
        strokeDasharray="5 7"
        animatedProps={linkRight}
      />
      <AnimatedG originX={287} originY={118} animatedProps={tickRight}>
        <Circle
          cx={287}
          cy={118}
          r={9.5}
          fill="#22A78F"
          stroke="#0b0e13"
          strokeWidth={2.5}
        />
        <Path
          d="M282 118 l 3.2 3.6 l 6.6 -7.2"
          stroke="#fff"
          strokeWidth={2.3}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </AnimatedG>

      {/* Nobody's servers: the cloud is ruled out last. */}
      <AnimatedG animatedProps={cloud}>
        <Path
          d="M272 34 c 1 -6 6 -10 12 -9 c 2 -5 8 -8 13 -6 c 5 2 8 6 7 11 c 5 1 8 5 7 9 c -1 5 -5 7 -9 7 l -22 0 c -5 0 -9 -5 -8 -12 z"
          fill="none"
          stroke="rgba(255,255,255,.30)"
          strokeWidth={1.8}
        />
        <AnimatedPath
          d="M266 56 L 316 16"
          stroke="#E55772"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeDasharray={STRIKE_LEN}
          animatedProps={strike}
        />
      </AnimatedG>
    </Svg>
  );
}
