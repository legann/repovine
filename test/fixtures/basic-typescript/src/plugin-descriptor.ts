// Default-export shapes. A default that re-exports a NAMED local declaration is the whole
// contract of a descriptor-style module, so it must project an export node; an anonymous default
// carries no nameable information and must stay filtered out.

export interface DescriptorShape {
  id: string;
  enabled: boolean;
}

const namedDescriptor: DescriptorShape = {
  id: 'named-descriptor',
  enabled: true,
};

export default namedDescriptor;
