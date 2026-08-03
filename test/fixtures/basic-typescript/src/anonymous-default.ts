// The negative half of the pair: an anonymous default has nothing to name it, so the projection
// must keep dropping it rather than emitting a node labelled `default` with no information.

export const anonymousMarker = 'anonymous-default-fixture';

export default {
  kind: 'anonymous',
  enabled: false,
};
