import { describe, expect, it } from '@jest/globals';
import { terraformParser } from '../../packages/plugins/iac-terraform/src/parser.js';

describe('terraformParser structural scanning', () => {
  it('ignores braces in heredocs and after escaped quotes', () => {
    const content = String.raw`
resource "aws_instance" "scripted" {
  user_data = <<-SCRIPT
    #!/bin/sh
    echo "}"
  SCRIPT
}

resource "aws_instance" "quoted" {
  description = "an escaped quote: \" and a non-structural }"
}

resource "aws_s3_bucket" "after" {
  bucket = "after"
}
`;

    const delta = terraformParser.parse('/repo/main.tf', 'main.tf', content);

    expect(delta).not.toBeNull();
    expect(delta?.resources.map(resource => resource.id)).toEqual(['scripted', 'quoted', 'after']);
    expect(delta?.resources[2]?.attributes?.bucket).toBe('after');
  });
});
