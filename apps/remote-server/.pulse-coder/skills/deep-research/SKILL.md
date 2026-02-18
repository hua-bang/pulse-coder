---
name: deep-research
description: Conduct comprehensive multi-round research using iterative web searches to gather, analyze, and synthesize information
version: 1.0.0
author: Pulse Coder Team
---

# Deep Research Skill

This skill enables comprehensive research through iterative web searches, allowing you to explore topics in depth by conducting 5-10 rounds of focused searches.

## When to Use

Use deep-research when you need to:
- Gather comprehensive information on complex topics
- Compare multiple approaches or solutions
- Understand emerging technologies or trends
- Research best practices across different sources
- Investigate technical problems with multiple facets
- Build a complete picture of a topic before making decisions

## Research Process

### 1. Initial Exploration (Rounds 1-2)
- Start with broad search queries to understand the topic landscape
- Identify key concepts, technologies, and terminology
- Note knowledge gaps and areas requiring deeper investigation

### 2. Focused Investigation (Rounds 3-6)
- Refine queries based on initial findings
- Dive deeper into specific subtopics
- Compare different approaches or solutions
- Gather technical details and implementation examples
- Look for authoritative sources and documentation

### 3. Synthesis & Validation (Rounds 7-10)
- Cross-reference information from multiple sources
- Validate findings with official documentation
- Look for recent updates or changes (2024-2026)
- Identify consensus vs. controversial aspects
- Fill remaining knowledge gaps

## Using the Tavily Tool

The `tavily` tool is available for web searches:

```typescript
// Example usage
await tavily.execute({
  query: "your search query here",
  maxResults: 5  // Optional, defaults to 5
});
```

## Search Strategy Tips

**Progressive Refinement**
- Round 1-2: Broad overview queries
- Round 3-5: Specific technical details
- Round 6-8: Edge cases and best practices
- Round 9-10: Recent updates and validation

**Query Formulation**
- Use specific technical terms when available
- Include year (2024-2026) for recent information
- Combine technology names with action words (e.g., "implement", "compare", "best practices")
- Ask about trade-offs and limitations

**Information Quality**
- Prioritize official documentation
- Look for recent blog posts from experts
- Check GitHub repositories for real examples
- Compare multiple sources for accuracy

## Output Structure

Present your research findings in this format:

**Overview**
- Brief summary of the topic
- Key findings and main takeaways

**Detailed Findings**
- Organized by subtopic or theme
- Include specific technical details
- Reference sources for important claims

**Comparison & Trade-offs** (if applicable)
- Different approaches or solutions
- Pros and cons of each
- Recommended scenarios for each option

**Implementation Guidance** (if applicable)
- Step-by-step approach
- Code examples or patterns
- Common pitfalls to avoid

**Sources**
- List all URLs consulted
- Group by relevance or topic

## Example Research Flow

**Topic: "Best practices for React Server Components in Next.js 14"**

Round 1: "React Server Components overview 2024"
Round 2: "Next.js 14 Server Components features"
Round 3: "Server Components vs Client Components when to use"
Round 4: "React Server Components data fetching patterns"
Round 5: "Next.js 14 Server Components performance"
Round 6: "Server Components best practices 2024"
Round 7: "Common mistakes React Server Components"
Round 8: "Server Components with Suspense and streaming"
Round 9: "Production experiences Server Components"
Round 10: "Server Components migration guide"

## Important Notes

- Each search builds on previous findings
- Adapt your strategy based on what you learn
- Don't repeat identical queries
- Balance breadth and depth appropriately
- Always cite sources in your final output
- Focus on actionable insights, not just information gathering
