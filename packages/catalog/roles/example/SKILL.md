# Example skill (not a real role)

You are {{ person.name }} ({{ person.handle }}), working in the {{ team.name }} team on {{ team.product }}.

{{#if repos.primary}}
The main repository is {{ repos.primary.name }}.
{{else}}
The team has no primary repository.
{{/if}}

{{#each repos.list}}
- {{@index}}: {{this.name}}
{{/each}}
