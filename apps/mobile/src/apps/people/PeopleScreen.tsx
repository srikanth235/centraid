// THE FRAME EVERY PEOPLE SURFACE SITS IN — now one of the six rooms (#1015).
//
// It owns the lockup, the claimed band and the Home capsule, and since Wave 2
// it owns the two things six surfaces each used to own separately: the header
// and the back affordance. `PeopleKit`'s `BackRow` is gone with them — three
// screens called the place they descended from by the app's name and three by
// a person's, and nothing could tell which was right (audit B7).
//
// The route decides all of it (`people-places.ts`): the word in the header,
// the band tab, and whether the parent is the roster or the person the surface
// is about. A screen passes the route it IS and, where the parent is a person,
// that person as a place.

import { useNavigation } from "@react-navigation/native";
import React from "react";

import { useBandOwner } from "../../kit/band/band-owner";
import type { SearchFieldProps } from "../../kit/components/SearchField";
import { AppPlace, PushedPage } from "../../kit/rooms";
import type { PlaceRef, RoomAction } from "../../kit/rooms";
import { resolveAppMeta } from "../../lib/gateway";
import type { PeopleShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import type { PeopleBandKey } from "./people-band";
import {
  isPeoplePlace,
  peopleDestinationFor,
  peopleParentPlace,
  peopleTitleFor,
} from "./people-places";
import type { PeopleRouteKey } from "./people-places";
import PeopleBand from "./PeopleBand";

const META = resolveAppMeta({
  id: "people",
  name: "People",
  description: "Everyone this vault knows.",
  iconKey: "Users",
  colorKey: "teal",
});

export interface PeopleScreenProps {
  /** The route this surface IS: its word, its band tab and the place it
   *  descends from are all read off it. */
  route: PeopleRouteKey;
  /** A person's own name, where the route is titled with it. */
  subject?: string;
  /** The person this surface is ABOUT, as the place it descends from. */
  parent?: PlaceRef;
  /** Leaving. The room draws the control; this is what it does. */
  onBack?: () => void;
  action?: RoomAction;
  secondary?: RoomAction;
  search?: SearchFieldProps;
  children: React.ReactNode;
  /** Hidden while a modal sheet owns the foot. */
  bandHidden?: boolean;
}

export default function PeopleScreen({
  route,
  subject,
  parent,
  onBack,
  action,
  secondary,
  search,
  children,
  bandHidden,
}: PeopleScreenProps): React.JSX.Element {
  const navigation = useNavigation<PeopleShellNavigation>();
  const { bandOwner } = useBandOwner("people");

  const onDestination = (key: PeopleBandKey): void => {
    // POP to PeopleHome, never push.
    navigation.popTo("PeopleHome", { destination: key });
  };

  // People has no selection mode, so the band the room hands back is live.
  const band =
    bandHidden === true
      ? undefined
      : (): React.JSX.Element => (
          <PeopleBand
            destination={peopleDestinationFor(route)}
            onHome={() => navigation.popTo("Home")}
            onSelect={onDestination}
            owner={bandOwner}
          />
        );

  // The vault lockup on every route (see `VaultBar`): which vault, which
  // gateway, and the product's two global verbs.
  const lockup = <VaultBar />;
  const title = peopleTitleFor(route, subject);
  const leave = onBack ?? ((): void => navigation.popTo("Home"));

  if (isPeoplePlace(route))
    return (
      <AppPlace
        action={action}
        app={{ color: META.color, iconKey: META.iconKey, title }}
        band={band}
        lockup={lockup}
        onBack={leave}
        search={search}
        secondary={secondary}
      >
        {children}
      </AppPlace>
    );

  return (
    <PushedPage
      action={action}
      backTo={peopleParentPlace(route, parent)}
      band={band}
      lockup={lockup}
      onBack={leave}
      search={search}
      secondary={secondary}
      title={title}
    >
      {children}
    </PushedPage>
  );
}
