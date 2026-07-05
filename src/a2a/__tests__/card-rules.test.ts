/**
 * Targeted card-rule tests (ADR-F2, ADR-F5 input tolerance).
 */

import { describe, expect, it } from 'vitest';

import { lintCard } from '../card-engine.js';
import type { AgentCardJson, AgentSkillJson } from '../card-types.js';

/** A minimal card that passes every rule — perturb per test. */
const baseSkill = (over: Partial<AgentSkillJson> = {}): AgentSkillJson => ({
  id: 'weather-forecast',
  name: 'Weather forecast',
  description: 'Returns a structured seven-day forecast; errors name the failing provider.',
  tags: ['weather', 'forecast'],
  ...over,
});

const baseCard = (over: Partial<AgentCardJson> = {}): AgentCardJson => ({
  name: 'Weather Agent',
  description: 'Structured weather data agent.',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/json'],
  supportedInterfaces: [
    { url: 'https://weather.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  skills: [baseSkill()],
  ...over,
});

const findingsFor = (card: AgentCardJson, ruleId: string) =>
  Object.values(lintCard(card).axisScores)
    .flatMap((a) => a.findings)
    .filter((f) => f.ruleId === ruleId);

describe('baseline card', () => {
  it('passes every rule except the unsigned-card warning', () => {
    const result = lintCard(baseCard());
    const nonSignature = Object.entries(result.axisScores)
      .filter(([axis]) => axis !== 'signature-hygiene')
      .flatMap(([, a]) => a.findings);
    expect(nonSignature).toEqual([]);
  });
});

describe('security-declaration-consistency', () => {
  it('accepts both securityRequirements and the §8.5 sample `security` spelling (ADR-F5)', () => {
    const schemes = {
      key: { apiKeySecurityScheme: { location: 'header', name: 'X-Key' } },
    };
    const protoSpelling = baseCard({
      securitySchemes: schemes,
      securityRequirements: [{ key: [] }],
    });
    const sampleSpelling = baseCard({ securitySchemes: schemes, security: [{ key: [] }] });
    expect(findingsFor(protoSpelling, 'undeclared-security-scheme')).toEqual([]);
    expect(findingsFor(sampleSpelling, 'undeclared-security-scheme')).toEqual([]);
    expect(findingsFor(protoSpelling, 'unused-security-scheme')).toEqual([]);
    expect(findingsFor(sampleSpelling, 'unused-security-scheme')).toEqual([]);
  });

  it('errors on requirements referencing undeclared schemes, including skill-level ones', () => {
    const card = baseCard({
      skills: [baseSkill({ securityRequirements: [{ ghost: [] }] })],
    });
    const findings = findingsFor(card, 'undeclared-security-scheme');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.skill).toBe('weather-forecast');
  });

  it('errors on a scheme wrapper missing its REQUIRED subfields', () => {
    const card = baseCard({
      securitySchemes: { key: { apiKeySecurityScheme: { location: 'header' } } },
      securityRequirements: [{ key: [] }],
    });
    const findings = findingsFor(card, 'incomplete-security-scheme');
    expect(findings.some((f) => f.severity === 'error' && f.field?.endsWith('.name'))).toBe(true);
  });

  it('warns on the pre-1.0 flat `type` scheme shape', () => {
    const card = baseCard({
      securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } },
      securityRequirements: [{ key: [] }],
    });
    const findings = findingsFor(card, 'incomplete-security-scheme');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.message).toContain('pre-1.0');
  });

  it('reports declared-but-unreferenced schemes at info severity', () => {
    const card = baseCard({
      securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X' } } },
    });
    const findings = findingsFor(card, 'unused-security-scheme');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
  });
});

describe('skill-selection-overlap', () => {
  it('flags near-identical skill names once per pair', () => {
    const card = baseCard({
      skills: [
        baseSkill(),
        baseSkill({ id: 'weather-forecasts', name: 'Weather forecasts' }),
      ],
    });
    const findings = findingsFor(card, 'overlapping-skill-names');
    expect(findings).toHaveLength(1);
  });

  it('flags identical tag sets regardless of order and case', () => {
    const card = baseCard({
      skills: [
        baseSkill(),
        baseSkill({
          id: 'climate-history',
          name: 'Climate history',
          tags: ['Forecast', 'weather'],
        }),
      ],
    });
    expect(findingsFor(card, 'identical-tag-sets')).toHaveLength(1);
  });
});

describe('extension-hygiene', () => {
  it('surfaces required:true extensions at info severity with the rejection consequence', () => {
    const card = baseCard({
      capabilities: {
        extensions: [
          {
            uri: 'https://example.com/ext/lease/v1',
            description: 'Capability lease negotiation.',
            required: true,
          },
        ],
      },
    });
    const findings = findingsFor(card, 'required-extension-declared');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.message).toContain('ExtensionSupportRequiredError');
  });

  it('warns harder on missing description when the extension is required', () => {
    const required = baseCard({
      capabilities: { extensions: [{ uri: 'https://e.com/a', required: true }] },
    });
    const optional = baseCard({
      capabilities: { extensions: [{ uri: 'https://e.com/a', required: false }] },
    });
    expect(findingsFor(required, 'extension-missing-description')[0]?.severity).toBe('warning');
    expect(findingsFor(optional, 'extension-missing-description')[0]?.severity).toBe('info');
  });
});

describe('interface-hygiene', () => {
  it('errors when supportedInterfaces is missing entirely', () => {
    const card = baseCard();
    delete card.supportedInterfaces;
    expect(findingsFor(card, 'no-supported-interfaces')).toHaveLength(1);
  });

  it('errors on a relative interface url', () => {
    const card = baseCard({
      supportedInterfaces: [
        { url: '/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
    });
    const findings = findingsFor(card, 'interface-hygiene');
    expect(
      findings.some((f) => f.severity === 'error' && f.message.includes('absolute')),
    ).toBe(true);
  });
});

describe('skill-namespacing', () => {
  it('fires prefix-consistency only past the ≥3-skill threshold with a dominant prefix', () => {
    const twoSkills = baseCard({
      skills: [baseSkill(), baseSkill({ id: 'other-thing', name: 'Other thing' })],
    });
    expect(findingsFor(twoSkills, 'skill-prefix-consistency')).toEqual([]);

    const outlier = baseCard({
      skills: [
        baseSkill({ id: 'weather-forecast' }),
        baseSkill({ id: 'weather-history', name: 'Weather history', tags: ['history'] }),
        baseSkill({ id: 'stock-quotes', name: 'Stock quotes', tags: ['stocks'] }),
      ],
    });
    const findings = findingsFor(outlier, 'skill-prefix-consistency');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.skill).toBe('stock-quotes');
  });
});
