# Example skill (not a real role)

The {{ team.name }} team works on {{ team.product }}.

{{#if repos.primary}}
The main repository is {{ repos.primary.name }}.
{{else}}
The team has no primary repository.
{{/if}}

{{#each repos.list}}
- {{@index}}: {{this.name}}
{{/each}}
