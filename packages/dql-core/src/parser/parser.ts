import type { SourceSpan } from '../errors/diagnostic.js';
import { DiagnosticReporter, DQLSyntaxError } from '../errors/reporter.js';
import { Lexer } from '../lexer/lexer.js';
import { TokenType, type Token, CHART_TYPES, FILTER_TYPES, SQL_START_KEYWORDS, normalizeChartType } from '../lexer/token.js';
import {
  NodeKind,
  type ProgramNode,
  type StatementNode,
  type DashboardNode,
  type ChartCallNode,
  type FilterCallNode,
  type VariableDeclNode,
  type DecoratorNode,
  type SQLQueryNode,
  type NamedArgNode,
  type ExpressionNode,
  type ChartType,
  type FilterType,
  type DashboardBodyItem,
  type TemplateInterpolation,
  type WorkbookNode,
  type PageNode,
  type ParamDeclNode,
  type ParamType,
  type ImportDeclNode,
  type UseDeclNode,
  type LayoutBlockNode,
  type LayoutRowNode,
  type LayoutRowItem,
  type BlockDeclNode,
  type DomainDeclNode,
  type TermDeclNode,
  type BusinessViewDeclNode,
  type BusinessViewIncludeNode,
  type BlockParamsNode,
  type BlockParamEntry,
  type BlockVisualizationNode,
  type BlockTestNode,
  type DigestNode,
  type NarrativeNode,
} from '../ast/nodes.js';
import {
  normalizeDatasetTileProvenance,
  normalizeSemanticTileConversionProvenance,
} from '../datasets/provenance.js';

const DRAFT_STRING_METADATA_FIELDS = new Set([
  'first_asked',
  'last_asked',
  'proposed_contract_id',
  'proposed_domain',
  'proposed_entity',
  'source_question',
  'source_block',
  'source_dql_kind',
  'source_dql_name',
  'source_dql_path',
  'source_dql_hash',
  'source_dql_time_dimension',
  'source_dql_granularity',
  'followup_kind',
  'context_pack_id',
  'route_intent',
  // Review-draft provenance for Tier-2 Ask answers: the de-duplication
  // fingerprint of the answer SQL and the run that produced it.
  'answer_fingerprint',
  'source_run_id',
  'time_dimension',
  'granularity',
  'draft_path',
  'dataset_tile_provenance',
  'derived_from',
  'semantic_tile_conversion_provenance',
]);

const DRAFT_ARRAY_METADATA_FIELDS = new Set([
  'upstream_refs',
  'requested_filters',
  'requested_dimensions',
  'order_by',
  'source_dql_metrics',
  'source_dql_dimensions',
  'source_dql_filters',
  'source_dql_order_by',
  'validation_warnings',
]);

function isDraftStringMetadataField(value: string): boolean {
  return DRAFT_STRING_METADATA_FIELDS.has(value);
}

function isDraftArrayMetadataField(value: string): boolean {
  return DRAFT_ARRAY_METADATA_FIELDS.has(value);
}

export class Parser {
  private tokens: Token[];
  private pos: number = 0;
  private source: string;
  private file: string | undefined;
  private reporter: DiagnosticReporter;

  constructor(source: string, file?: string) {
    this.source = source;
    this.file = file;
    this.reporter = new DiagnosticReporter();

    const lexer = new Lexer(source, file);
    this.tokens = lexer.tokenize();
  }

  parse(): ProgramNode {
    const start = this.currentSpan();
    const statements: StatementNode[] = [];

    while (!this.isAtEnd()) {
      const posBefore = this.pos;
      try {
        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
        }
      } catch (e) {
        // Skip to next statement-level token on error
        this.synchronize();
      }
      // Safety net: if neither parseStatement nor synchronize() advanced the
      // cursor, force-advance. Without this, unrecognized input (e.g. a raw SQL
      // cell mistakenly handed to the DQL parser) spins this loop forever and
      // OOM-crashes the process.
      if (this.pos === posBefore && !this.isAtEnd()) {
        this.advance();
      }
    }

    if (this.reporter.hasErrors()) {
      throw new DQLSyntaxError(
        `Parse errors in ${this.file ?? '<input>'}`,
        this.reporter.getErrors(),
      );
    }

    return {
      kind: NodeKind.Program,
      statements,
      span: this.makeSpan(start, this.currentSpan()),
    };
  }

  private parseStatement(): StatementNode | null {
    // Collect leading decorators
    const decorators = this.parseDecoratorList();

    if (this.check(TokenType.WorkbookKeyword)) {
      return this.parseWorkbook(decorators);
    }

    if (this.check(TokenType.DashboardKeyword)) {
      return this.parseDashboard(decorators);
    }

    if (this.check(TokenType.DigestKeyword)) {
      return this.parseDigest(decorators);
    }

    if (this.check(TokenType.ChartKeyword)) {
      return this.parseChartCall(decorators);
    }

    if (this.check(TokenType.BlockKeyword)) {
      return this.parseBlockDecl(decorators);
    }

    if (this.check(TokenType.DomainKeyword)) {
      return this.parseDomainDecl(decorators);
    }

    if (this.check(TokenType.TermKeyword)) {
      return this.parseTermDecl(decorators);
    }

    if (this.check(TokenType.BusinessViewKeyword)) {
      return this.parseBusinessViewDecl(decorators);
    }

    if (this.check(TokenType.ImportKeyword)) {
      if (decorators.length > 0) {
        this.error('Decorators cannot be applied to import statements.');
      }
      return this.parseImportDecl();
    }

    if (this.check(TokenType.EOF)) {
      return null;
    }

    this.error(`Unexpected token '${this.current().value}'. Expected 'dashboard', 'digest', 'workbook', 'chart', 'domain', 'block', 'term', 'business_view', or 'import'.`);
    return null;
  }

  private parseFilterCall(): FilterCallNode {
    const start = this.currentSpan();
    this.expect(TokenType.FilterKeyword);
    this.expect(TokenType.Dot);

    const filterTypeToken = this.expect(TokenType.Identifier);
    if (!FILTER_TYPES.has(filterTypeToken.value)) {
      this.reporter.error(
        `Unknown filter type '${filterTypeToken.value}'. Valid types: ${[...FILTER_TYPES].join(', ')}`,
        filterTypeToken.span,
        `Did you mean one of: ${[...FILTER_TYPES].join(', ')}?`,
      );
    }

    this.expect(TokenType.LeftParen);

    // Check if there's a SQL query (SELECT/WITH) or just named args
    let query: SQLQueryNode | undefined;
    const currentToken = this.current();
    const tokenVal = currentToken.value.toUpperCase();

    if (tokenVal === 'SELECT' || tokenVal === 'WITH') {
      query = this.parseSQLQuery();
    }

    // Parse named arguments
    const args: NamedArgNode[] = [];
    while (this.check(TokenType.Comma) || (!query && (this.check(TokenType.Identifier) || this.isKeywordUsableAsArgName(this.current().type)))) {
      if (this.check(TokenType.Comma)) {
        this.advance(); // consume comma
      }
      if (this.check(TokenType.RightParen)) break; // trailing comma
      args.push(this.parseNamedArg());
    }

    this.expect(TokenType.RightParen);

    return {
      kind: NodeKind.FilterCall,
      filterType: filterTypeToken.value as FilterType,
      query,
      args,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseDashboard(decorators: DecoratorNode[]): DashboardNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.DashboardKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const body: DashboardBodyItem[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      // Collect decorators for items inside dashboard
      const itemDecorators = this.parseDecoratorList();

      if (this.check(TokenType.LetKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to variable declarations.');
        }
        body.push(this.parseVariableDecl());
      } else if (this.check(TokenType.ParamKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to param declarations.');
        }
        body.push(this.parseParamDecl());
      } else if (this.check(TokenType.ChartKeyword)) {
        body.push(this.parseChartCall(itemDecorators));
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        body.push(this.parseFilterCall());
      } else if (this.check(TokenType.UseKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to use declarations.');
        }
        body.push(this.parseUseDecl());
      } else if (this.check(TokenType.LayoutKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to layout blocks.');
        }
        body.push(this.parseLayoutBlock());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside dashboard. Expected 'let', 'param', 'chart', 'filter', 'use', 'layout', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Dashboard,
      title: titleToken.value,
      decorators,
      body,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseDigest(decorators: DecoratorNode[]): DigestNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.DigestKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const body: DashboardBodyItem[] = [];
    let narrative: NarrativeNode | undefined;

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const itemDecorators = this.parseDecoratorList();

      if (this.check(TokenType.NarrativeKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to narrative blocks.');
        }
        if (narrative) {
          this.error('A digest can only contain one narrative block.');
        }
        narrative = this.parseNarrative();
      } else if (this.check(TokenType.LetKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to variable declarations.');
        }
        body.push(this.parseVariableDecl());
      } else if (this.check(TokenType.ParamKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to param declarations.');
        }
        body.push(this.parseParamDecl());
      } else if (this.check(TokenType.ChartKeyword)) {
        body.push(this.parseChartCall(itemDecorators));
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        body.push(this.parseFilterCall());
      } else if (this.check(TokenType.UseKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to use declarations.');
        }
        body.push(this.parseUseDecl());
      } else if (this.check(TokenType.LayoutKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to layout blocks.');
        }
        body.push(this.parseLayoutBlock());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside digest. Expected 'narrative', 'let', 'param', 'chart', 'filter', 'use', 'layout', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Digest,
      title: titleToken.value,
      decorators,
      narrative,
      body,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseNarrative(): NarrativeNode {
    const start = this.currentSpan();
    this.expect(TokenType.NarrativeKeyword);
    this.expect(TokenType.LeftBrace);

    const properties: NamedArgNode[] = [];
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      properties.push(this.parseNamedArg());
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Narrative,
      properties,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseChartCall(decorators: DecoratorNode[]): ChartCallNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.ChartKeyword);
    this.expect(TokenType.Dot);

    const chartTypeStart = this.currentSpan();
    const chartTypeToken = this.expect(TokenType.Identifier);
    let rawChartType = chartTypeToken.value;
    while (this.check(TokenType.Minus)) {
      this.advance();
      rawChartType += `-${this.expect(TokenType.Identifier).value}`;
    }
    const chartTypeSpan = this.makeSpan(chartTypeStart, this.previousSpan());
    if (!CHART_TYPES.has(rawChartType)) {
      this.reporter.error(
        `Unknown chart type '${rawChartType}'. Valid types: ${[...CHART_TYPES].join(', ')}`,
        chartTypeSpan,
        `Did you mean one of: ${[...CHART_TYPES].join(', ')}?`,
      );
    }
    const normalizedChartType = normalizeChartType(rawChartType);

    this.expect(TokenType.LeftParen);

    // Parse the SQL query using boundary detection on the raw source
    const query = this.parseSQLQuery();

    // Parse named arguments
    const args: NamedArgNode[] = [];
    while (this.check(TokenType.Comma)) {
      this.advance(); // consume comma
      if (this.check(TokenType.RightParen)) break; // trailing comma
      args.push(this.parseNamedArg());
    }

    this.expect(TokenType.RightParen);

    return {
      kind: NodeKind.ChartCall,
      chartType: normalizedChartType as ChartType,
      query,
      args,
      decorators,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseSQLQuery(): SQLQueryNode {
    const start = this.currentSpan();

    // We need to find the SQL text from the raw source.
    // The current token should be the start of the SQL (SELECT, WITH, etc.)
    // We use Lexer.scanSQLBoundary on the raw source to find where SQL ends.
    const currentToken = this.current();
    const sqlStartOffset = currentToken.span.start.offset;

    // Scan the raw source for SQL boundary
    const { sql, endOffset } = Lexer.scanSQLBoundary(this.source, sqlStartOffset, 1);

    // Extract template interpolations from the SQL text
    const interpolations = this.extractInterpolations(sql, start);

    // Now advance our token position past all tokens that fall within the SQL range
    while (
      !this.isAtEnd() &&
      this.current().span.start.offset < endOffset
    ) {
      this.advance();
    }

    const span = this.makeSpan(start, this.currentSpan());

    return {
      kind: NodeKind.SQLQuery,
      rawSQL: sql,
      interpolations,
      span,
    };
  }

  private extractInterpolations(sql: string, baseSpan: SourceSpan): TemplateInterpolation[] {
    const interpolations: TemplateInterpolation[] = [];
    const regex = /\$\{(\w+)\}|\{(\w+)\}/g;
    let match;

    while ((match = regex.exec(sql)) !== null) {
      const variableName = match[1] || match[2];
      if (!variableName) continue;
      interpolations.push({
        variableName,
        offsetInSQL: match.index,
        span: baseSpan, // simplified; ideally compute exact position
      });
    }

    return interpolations;
  }

  private parseNamedArg(): NamedArgNode {
    const start = this.currentSpan();
    // Accept identifiers and keywords that may be used as argument names (e.g. 'param', 'label', 'from')
    const nameToken = this.current();
    if (nameToken.type === TokenType.Identifier || this.isKeywordUsableAsArgName(nameToken.type)) {
      this.advance();
    } else {
      this.error(`Expected argument name, got '${nameToken.value}'.`);
      this.advance();
    }
    this.expect(TokenType.Equals);
    const value = this.parseExpression();

    return {
      kind: NodeKind.NamedArg,
      name: nameToken.value,
      value,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private isKeywordUsableAsArgName(type: TokenType): boolean {
    return type === TokenType.ParamKeyword
      || type === TokenType.FromKeyword
      || type === TokenType.LayoutKeyword
      || type === TokenType.RowKeyword
      || type === TokenType.UseKeyword
      || type === TokenType.ImportKeyword
      || type === TokenType.MetricKeyword
      || type === TokenType.MetricsKeyword
      || type === TokenType.TermsKeyword
      || type === TokenType.IncludesKeyword;
  }

  private parseVariableDecl(): VariableDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.LetKeyword);
    const nameToken = this.expect(TokenType.Identifier);
    this.expect(TokenType.Equals);
    const initializer = this.parseExpression();

    return {
      kind: NodeKind.VariableDecl,
      name: nameToken.value,
      initializer,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseDecoratorList(): DecoratorNode[] {
    const decorators: DecoratorNode[] = [];
    while (this.check(TokenType.AtSign)) {
      decorators.push(this.parseDecorator());
    }
    return decorators;
  }

  private parseDecorator(): DecoratorNode {
    const start = this.currentSpan();
    this.expect(TokenType.AtSign);
    const nameToken = this.expect(TokenType.Identifier);

    const args: ExpressionNode[] = [];
    if (this.check(TokenType.LeftParen)) {
      this.advance(); // consume (
      if (!this.check(TokenType.RightParen)) {
        args.push(this.parseExpression());
        while (this.check(TokenType.Comma)) {
          this.advance();
          args.push(this.parseExpression());
        }
      }
      this.expect(TokenType.RightParen);
    }

    return {
      kind: NodeKind.Decorator,
      name: nameToken.value,
      arguments: args,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseExpression(): ExpressionNode {
    let left = this.parsePrimary();

    // Handle binary + and - operators
    while (this.check(TokenType.Plus) || this.check(TokenType.Minus)) {
      const opToken = this.advance();
      const right = this.parsePrimary();
      left = {
        kind: NodeKind.BinaryExpr,
        operator: opToken.value as '+' | '-',
        left,
        right,
        span: this.makeSpan(left.span, right.span),
      };
    }

    return left;
  }

  private parsePrimary(): ExpressionNode {
    const token = this.current();

    // String literal
    if (this.check(TokenType.StringLiteral)) {
      this.advance();
      return {
        kind: NodeKind.StringLiteral,
        value: token.value,
        span: token.span,
      };
    }

    // Number literal
    if (this.check(TokenType.NumberLiteral)) {
      this.advance();
      return {
        kind: NodeKind.NumberLiteral,
        value: Number(token.value),
        span: token.span,
      };
    }

    // Boolean literal
    if (this.check(TokenType.BooleanLiteral)) {
      this.advance();
      return {
        kind: NodeKind.BooleanLiteral,
        value: token.value === 'true',
        span: token.span,
      };
    }

    // Array literal
    if (this.check(TokenType.LeftBracket)) {
      return this.parseArrayLiteral();
    }

    // INTERVAL expression
    if (this.check(TokenType.IntervalKeyword)) {
      const start = this.currentSpan();
      this.advance(); // consume INTERVAL
      const valueToken = this.expect(TokenType.StringLiteral);
      return {
        kind: NodeKind.IntervalExpr,
        value: valueToken.value,
        span: this.makeSpan(start, this.previousSpan()),
      };
    }

    // Identifier (may be function call)
    if (this.check(TokenType.Identifier)) {
      this.advance();
      const name = token.value;

      // Check for function call: ident(
      if (this.check(TokenType.LeftParen)) {
        return this.parseFunctionCall(name, token.span);
      }

      return {
        kind: NodeKind.Identifier,
        name,
        span: token.span,
      };
    }

    // Negative number (minus followed by number)
    if (this.check(TokenType.Minus)) {
      const start = this.currentSpan();
      this.advance();
      const numToken = this.expect(TokenType.NumberLiteral);
      return {
        kind: NodeKind.NumberLiteral,
        value: -Number(numToken.value),
        span: this.makeSpan(start, numToken.span),
      };
    }

    this.error(`Unexpected token '${token.value}'. Expected an expression.`);
    this.advance();
    return {
      kind: NodeKind.Identifier,
      name: '__error__',
      span: token.span,
    };
  }

  private parseArrayLiteral(): ExpressionNode {
    const start = this.currentSpan();
    this.expect(TokenType.LeftBracket);

    const elements: ExpressionNode[] = [];
    if (!this.check(TokenType.RightBracket)) {
      elements.push(this.parseExpression());
      while (this.check(TokenType.Comma)) {
        this.advance();
        if (this.check(TokenType.RightBracket)) break; // trailing comma
        elements.push(this.parseExpression());
      }
    }

    this.expect(TokenType.RightBracket);

    return {
      kind: NodeKind.ArrayLiteral,
      elements,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseFunctionCall(callee: string, start: SourceSpan): ExpressionNode {
    this.expect(TokenType.LeftParen);

    const args: ExpressionNode[] = [];
    if (!this.check(TokenType.RightParen)) {
      args.push(this.parseExpression());
      while (this.check(TokenType.Comma)) {
        this.advance();
        args.push(this.parseExpression());
      }
    }

    this.expect(TokenType.RightParen);

    return {
      kind: NodeKind.FunctionCall,
      callee,
      arguments: args,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Helpers ----

  private current(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private previous(): Token {
    return this.tokens[this.pos - 1] ?? this.tokens[0];
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private advance(): Token {
    const token = this.current();
    if (!this.isAtEnd()) {
      this.pos++;
    }
    return token;
  }

  private skipBalancedBlock(): void {
    if (!this.check(TokenType.LeftBrace)) return;
    let depth = 0;
    while (!this.isAtEnd()) {
      if (this.check(TokenType.LeftBrace)) {
        depth += 1;
        this.advance();
        continue;
      }
      if (this.check(TokenType.RightBrace)) {
        depth -= 1;
        this.advance();
        if (depth <= 0) return;
        continue;
      }
      this.advance();
    }
  }

  private expect(type: TokenType): Token {
    if (this.check(type)) {
      return this.advance();
    }

    const token = this.current();
    this.error(
      `Expected ${type} but found '${token.value}' (${token.type}).`,
    );

    // Return a synthetic token to keep parsing
    return {
      type,
      value: '',
      span: token.span,
    };
  }

  private expectStringLike(): Token {
    if (this.check(TokenType.StringLiteral) || this.check(TokenType.TripleQuoteString)) {
      return this.advance();
    }
    return this.expect(TokenType.StringLiteral);
  }

  private isAtEnd(): boolean {
    return this.current().type === TokenType.EOF;
  }

  private error(message: string): void {
    this.reporter.error(message, this.currentSpan());
  }

  private currentSpan(): SourceSpan {
    return this.current().span;
  }

  private previousSpan(): SourceSpan {
    return this.previous().span;
  }

  private makeSpan(start: SourceSpan, end: SourceSpan): SourceSpan {
    return { start: start.start, end: end.end };
  }

  // ---- Domain Declaration ----

  private parseDomainDecl(decorators: DecoratorNode[]): DomainDeclNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.DomainKeyword);

    const nameToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    let id: string | undefined;
    let owner: string | undefined;
    let parent: string | undefined;
    let businessOwner: string | undefined;
    let boundedContext: string | undefined;
    let sourceSystems: string[] | undefined;
    let primaryTerms: string[] | undefined;
    let reviewCadence: string | undefined;
    let tags: string[] | undefined;
    let businessOutcome: string | undefined;
    let description: string | undefined;
    let inScope: string[] | undefined;
    let outOfScope: string[] | undefined;
    let dbtGroups: string[] | undefined;
    let dbtPaths: string[] | undefined;
    let dbtTags: string[] | undefined;
    let semanticDomains: string[] | undefined;
    let semanticTags: string[] | undefined;
    let exports: string[] | undefined;

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.OwnerKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        owner = this.expect(TokenType.StringLiteral).value;
      } else if (this.check(TokenType.DescriptionKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        description = this.expectStringLike().value;
      } else if (this.check(TokenType.TagsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        tags = this.parseStringArrayValues();
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'id'
          || this.current().value === 'parent'
          || this.current().value === 'businessOwner'
          || this.current().value === 'boundedContext'
          || this.current().value === 'sourceSystems'
          || this.current().value === 'primaryTerms'
          || this.current().value === 'reviewCadence'
          || this.current().value === 'businessOutcome'
          || this.current().value === 'inScope'
          || this.current().value === 'outOfScope'
          || this.current().value === 'dbtGroups'
          || this.current().value === 'dbtPaths'
          || this.current().value === 'dbtTags'
          || this.current().value === 'semanticDomains'
          || this.current().value === 'semanticTags'
          || this.current().value === 'exports')
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        if (keyToken.value === 'id') {
          id = this.expect(TokenType.StringLiteral).value;
        } else if (keyToken.value === 'parent') {
          parent = this.expect(TokenType.StringLiteral).value;
        } else if (keyToken.value === 'businessOwner') {
          businessOwner = this.expect(TokenType.StringLiteral).value;
        } else if (keyToken.value === 'boundedContext') {
          boundedContext = this.expectStringLike().value;
        } else if (keyToken.value === 'sourceSystems') {
          sourceSystems = this.parseStringArrayValues();
        } else if (keyToken.value === 'primaryTerms') {
          primaryTerms = this.parseStringArrayValues();
        } else if (keyToken.value === 'reviewCadence') {
          reviewCadence = this.expect(TokenType.StringLiteral).value;
        } else if (keyToken.value === 'businessOutcome') {
          businessOutcome = this.expect(TokenType.StringLiteral).value;
        } else if (keyToken.value === 'inScope') {
          inScope = this.parseStringArrayValues();
        } else if (keyToken.value === 'outOfScope') {
          outOfScope = this.parseStringArrayValues();
        } else if (keyToken.value === 'dbtGroups') {
          dbtGroups = this.parseStringArrayValues();
        } else if (keyToken.value === 'dbtPaths') {
          dbtPaths = this.parseStringArrayValues();
        } else if (keyToken.value === 'dbtTags') {
          dbtTags = this.parseStringArrayValues();
        } else if (keyToken.value === 'semanticDomains') {
          semanticDomains = this.parseStringArrayValues();
        } else if (keyToken.value === 'semanticTags') {
          semanticTags = this.parseStringArrayValues();
        } else if (keyToken.value === 'exports') {
          exports = this.parseStringArrayValues();
        }
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside domain. Expected 'id', 'parent', 'owner', 'businessOwner', 'boundedContext', 'sourceSystems', 'primaryTerms', 'reviewCadence', 'tags', 'businessOutcome', 'description', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.DomainDecl,
      name: nameToken.value,
      id,
      parent,
      owner,
      businessOwner,
      boundedContext,
      sourceSystems,
      primaryTerms,
      reviewCadence,
      tags,
      businessOutcome,
      description,
      inScope,
      outOfScope,
      dbtGroups,
      dbtPaths,
      dbtTags,
      semanticDomains,
      semanticTags,
      exports,
      decorators,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Business Term Declaration ----

  private parseTermDecl(decorators: DecoratorNode[]): TermDeclNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.TermKeyword);

    const nameToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    let domain: string | undefined;
    let termType: string | undefined;
    let status: string | undefined;
    let description: string | undefined;
    let tags: string[] | undefined;
    let owner: string | undefined;
    let identifiers: string[] | undefined;
    let synonyms: string[] | undefined;
    let metricRefs: string[] | undefined;
    let businessOutcome: string | undefined;
    let businessOwner: string | undefined;
    let decisionUse: string | undefined;
    let reviewCadence: string | undefined;
    let businessRules: string[] | undefined;
    let caveats: string[] | undefined;

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.DomainKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        domain = val.value;
      } else if (this.check(TokenType.TypeKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        termType = val.value;
      } else if (this.check(TokenType.DescriptionKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expectStringLike();
        description = val.value;
      } else if (this.check(TokenType.TagsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        tags = this.parseStringArrayValues();
      } else if (this.check(TokenType.OwnerKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        owner = val.value;
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'status'
          || this.current().value === 'identifiers'
          || this.current().value === 'synonyms'
          || this.current().value === 'metricRefs'
          || this.current().value === 'businessOutcome'
          || this.current().value === 'businessOwner'
          || this.current().value === 'decisionUse'
          || this.current().value === 'reviewCadence'
          || this.current().value === 'businessRules'
          || this.current().value === 'caveats')
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        if (keyToken.value === 'status') {
          const val = this.expect(TokenType.StringLiteral);
          status = val.value;
        } else if (keyToken.value === 'identifiers') {
          identifiers = this.parseStringArrayValues();
        } else if (keyToken.value === 'synonyms') {
          synonyms = this.parseStringArrayValues();
        } else if (keyToken.value === 'metricRefs') {
          metricRefs = this.parseStringArrayValues();
        } else if (keyToken.value === 'businessOutcome') {
          const val = this.expect(TokenType.StringLiteral);
          businessOutcome = val.value;
        } else if (keyToken.value === 'businessOwner') {
          const val = this.expect(TokenType.StringLiteral);
          businessOwner = val.value;
        } else if (keyToken.value === 'decisionUse') {
          const val = this.expect(TokenType.StringLiteral);
          decisionUse = val.value;
        } else if (keyToken.value === 'reviewCadence') {
          const val = this.expect(TokenType.StringLiteral);
          reviewCadence = val.value;
        } else if (keyToken.value === 'businessRules') {
          businessRules = this.parseStringArrayValues();
        } else if (keyToken.value === 'caveats') {
          caveats = this.parseStringArrayValues();
        }
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside term. Expected 'domain', 'type', 'status', 'description', 'tags', 'owner', 'identifiers', 'synonyms', 'metricRefs', 'businessOutcome', 'businessOwner', 'decisionUse', 'reviewCadence', 'businessRules', 'caveats', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.TermDecl,
      name: nameToken.value,
      domain,
      termType,
      status,
      description,
      tags,
      owner,
      identifiers,
      synonyms,
      metricRefs,
      businessOutcome,
      businessOwner,
      decisionUse,
      reviewCadence,
      businessRules,
      caveats,
      decorators,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Business View Declaration ----

  private parseBusinessViewDecl(decorators: DecoratorNode[]): BusinessViewDeclNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.BusinessViewKeyword);

    const nameToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    let domain: string | undefined;
    let status: string | undefined;
    let description: string | undefined;
    let tags: string[] | undefined;
    let owner: string | undefined;
    let termRefs: string[] | undefined;
    let businessOutcome: string | undefined;
    let businessOwner: string | undefined;
    let decisionUse: string | undefined;
    let reviewCadence: string | undefined;
    let businessRules: string[] | undefined;
    let caveats: string[] | undefined;
    let includes: BusinessViewIncludeNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.DomainKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        domain = val.value;
      } else if (this.check(TokenType.DescriptionKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expectStringLike();
        description = val.value;
      } else if (this.check(TokenType.TagsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        tags = this.parseStringArrayValues();
      } else if (this.check(TokenType.OwnerKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        owner = val.value;
      } else if (this.check(TokenType.TermsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        termRefs = this.parseStringArrayValues();
      } else if (this.check(TokenType.IncludesKeyword)) {
        includes = this.parseBusinessViewIncludes();
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'status'
          || this.current().value === 'businessOutcome'
          || this.current().value === 'businessOwner'
          || this.current().value === 'decisionUse'
          || this.current().value === 'reviewCadence'
          || this.current().value === 'businessRules'
          || this.current().value === 'caveats')
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        if (keyToken.value === 'status') {
          const val = this.expect(TokenType.StringLiteral);
          status = val.value;
        } else if (keyToken.value === 'businessOutcome') {
          const val = this.expect(TokenType.StringLiteral);
          businessOutcome = val.value;
        } else if (keyToken.value === 'businessOwner') {
          const val = this.expect(TokenType.StringLiteral);
          businessOwner = val.value;
        } else if (keyToken.value === 'decisionUse') {
          const val = this.expect(TokenType.StringLiteral);
          decisionUse = val.value;
        } else if (keyToken.value === 'reviewCadence') {
          const val = this.expect(TokenType.StringLiteral);
          reviewCadence = val.value;
        } else if (keyToken.value === 'businessRules') {
          businessRules = this.parseStringArrayValues();
        } else if (keyToken.value === 'caveats') {
          caveats = this.parseStringArrayValues();
        }
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside business_view. Expected 'domain', 'status', 'description', 'tags', 'owner', 'terms', 'businessOutcome', 'businessOwner', 'decisionUse', 'reviewCadence', 'businessRules', 'caveats', 'includes', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BusinessViewDecl,
      name: nameToken.value,
      domain,
      status,
      description,
      tags,
      owner,
      termRefs,
      businessOutcome,
      businessOwner,
      decisionUse,
      reviewCadence,
      businessRules,
      caveats,
      includes,
      decorators,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseBusinessViewIncludes(): BusinessViewIncludeNode[] {
    this.expect(TokenType.IncludesKeyword);
    this.expect(TokenType.LeftBrace);

    const includes: BusinessViewIncludeNode[] = [];
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const start = this.currentSpan();
      if (this.check(TokenType.BlockKeyword)) {
        this.advance();
        const nameToken = this.expect(TokenType.StringLiteral);
        includes.push({
          kind: NodeKind.BusinessViewInclude,
          refType: 'block',
          name: nameToken.value,
          span: this.makeSpan(start, this.previousSpan()),
        });
      } else if (this.check(TokenType.BusinessViewKeyword)) {
        this.advance();
        const nameToken = this.expect(TokenType.StringLiteral);
        includes.push({
          kind: NodeKind.BusinessViewInclude,
          refType: 'business_view',
          name: nameToken.value,
          span: this.makeSpan(start, this.previousSpan()),
        });
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside includes. Expected 'block', 'business_view', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);
    return includes;
  }

  private parseStringArrayValues(): string[] {
    const arrExpr = this.parseArrayLiteral();
    if (arrExpr.kind !== NodeKind.ArrayLiteral) return [];
    return arrExpr.elements
      .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
      .map((e) => e.value);
  }

  // ---- Block Declaration ----

  private parseBlockDecl(decorators: DecoratorNode[]): BlockDeclNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.BlockKeyword);

    const nameToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    let domain: string | undefined;
    let blockType: 'semantic' | 'custom' | undefined;
    let metricRef: string | undefined;
    let metricsRef: string[] | undefined;
    let parsedDimensions: string[] | undefined;
    let description: string | undefined;
    let tags: string[] | undefined;
    let owner: string | undefined;
    let termRefs: string[] | undefined;
    let pattern: string | undefined;
    let datasetGrain: BlockDeclNode['datasetGrain'] | undefined;
    let datasetFields: BlockDeclNode['datasetFields'] | undefined;
    let datasetMeasures: BlockDeclNode['datasetMeasures'] | undefined;
    let grain: string | undefined;
    let entities: string[] | undefined;
    let outputs: string[] | undefined;
    let allowedFilters: string[] | undefined;
    let parameterPolicy: BlockDeclNode['parameterPolicy'] | undefined;
    let filterBindings: BlockDeclNode['filterBindings'] | undefined;
    let metricMappings: BlockDeclNode['metricMappings'] | undefined;
    let sourceSystems: string[] | undefined;
    let replacementFor: string[] | undefined;
    let params: BlockParamsNode | undefined;
    let query: SQLQueryNode | undefined;
    let visualization: BlockVisualizationNode | undefined;
    let tests: BlockTestNode[] | undefined;
    // v1.2 Track G — agent-facing metadata.
    let llmContext: string | undefined;
    let invariants: string[] | undefined;
    let examples: Array<{ question: string; sql?: string }> | undefined;
    let businessOutcome: string | undefined;
    let businessOwner: string | undefined;
    let decisionUse: string | undefined;
    let reviewCadence: string | undefined;
    let businessRules: string[] | undefined;
    let caveats: string[] | undefined;
    // Question aliases: other words people use for what this block answers.
    let synonyms: string[] | undefined;
    // Business terms in the block's own words (free text; `terms` names declared terms).
    let primaryTerms: string[] | undefined;
    // v1.4 — block certification status. Already surfaced by the manifest
    // builder via extractProp, the certifier, and the agent's "block-first"
    // matcher; the parser just needs to accept it as a valid top-level
    // property. Recognised values: BlockStatus union from dql-project.
    let status: string | undefined;
    // Retirement metadata for deprecated blocks (see BlockDeclNode).
    let replacedBy: string | undefined;
    let deprecatedOn: string | undefined;
    // v1.6 — DataLex contract reference. Identifier-keyed (no new lexer
    // keyword needed). The semantic analyzer resolves the value against
    // the project's DataLex manifest and emits diagnostics for unresolved
    // / malformed references. See contracts/registry.ts.
    let datalexContract: string | undefined;
    // Tier-2 generated draft metadata. Kept flat so generated proposals remain
    // regular draft blocks that compile and can be indexed.
    let askedTimes: number | undefined;
    let firstAsked: string | undefined;
    let lastAsked: string | undefined;
    let proposedContractId: string | undefined;
    let proposedDomain: string | undefined;
    let proposedEntity: string | undefined;
    let sourceQuestion: string | undefined;
    let sourceBlock: string | undefined;
    let sourceDqlKind: string | undefined;
    let sourceDqlName: string | undefined;
    let sourceDqlPath: string | undefined;
    let sourceDqlHash: string | undefined;
    let sourceDqlTimeDimension: string | undefined;
    let sourceDqlGranularity: string | undefined;
    let followupKind: string | undefined;
    let contextPackId: string | undefined;
    let routeIntent: string | undefined;
    let timeDimension: string | undefined;
    let granularity: string | undefined;
    let draftPath: string | undefined;
    let upstreamRefs: string[] | undefined;
    let requestedFilters: string[] | undefined;
    let requestedDimensions: string[] | undefined;
    let orderBy: string[] | undefined;
    let limit: number | undefined;
    let sourceDqlMetrics: string[] | undefined;
    let sourceDqlDimensions: string[] | undefined;
    let sourceDqlFilters: string[] | undefined;
    let sourceDqlOrderBy: string[] | undefined;
    let sourceDqlLimit: number | undefined;
    let validationWarnings: string[] | undefined;
    let datasetTileProvenance: BlockDeclNode['datasetTileProvenance'] | undefined;
    let derivedFrom: BlockDeclNode['derivedFrom'] | undefined;
    let semanticTileConversionProvenance: BlockDeclNode['semanticTileConversionProvenance'] | undefined;

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.DomainKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        domain = val.value;
      } else if (this.check(TokenType.TypeKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        const raw = val.value;
        if (raw === 'semantic' || raw === 'custom') {
          blockType = raw;
        } else {
          this.error(
            `Block type must be "semantic" or "custom", got "${raw}". Use type = "semantic" for dbt metric blocks or type = "custom" for SQL blocks.`,
          );
          blockType = 'custom'; // recover gracefully
        }
      } else if (this.check(TokenType.MetricKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        metricRef = val.value;
      } else if (this.check(TokenType.MetricsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const arrExpr = this.parseArrayLiteral();
        if (arrExpr.kind === NodeKind.ArrayLiteral) {
          metricsRef = arrExpr.elements
            .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
            .map((e) => e.value);
        }
      } else if (this.check(TokenType.DimensionsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const arrExpr = this.parseArrayLiteral();
        if (arrExpr.kind === NodeKind.ArrayLiteral) {
          parsedDimensions = arrExpr.elements
            .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
            .map((e) => e.value);
        }
      } else if (this.check(TokenType.DescriptionKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expectStringLike();
        description = val.value;
      } else if (this.check(TokenType.TagsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const arrExpr = this.parseArrayLiteral();
        if (arrExpr.kind === NodeKind.ArrayLiteral) {
          tags = arrExpr.elements
            .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
            .map((e) => e.value);
        }
      } else if (this.check(TokenType.OwnerKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        owner = val.value;
      } else if (this.check(TokenType.TermsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        termRefs = this.parseStringArrayValues();
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'grain'
          || this.current().value === 'pattern'
          || this.current().value === 'entities'
          || this.current().value === 'outputs'
          || this.current().value === 'allowedFilters'
          || this.current().value === 'sourceSystems'
          || this.current().value === 'replacementFor')
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        if (keyToken.value === 'pattern') {
          const val = this.expect(TokenType.StringLiteral);
          pattern = val.value;
        } else if (keyToken.value === 'grain') {
          if (this.check(TokenType.LeftBrace)) datasetGrain = this.parseBlockDatasetGrain();
          else {
            const val = this.expect(TokenType.StringLiteral);
            grain = val.value;
          }
        } else if (keyToken.value === 'entities') {
          entities = this.parseStringArrayValues();
        } else if (keyToken.value === 'outputs') {
          outputs = this.parseStringArrayValues();
        } else if (keyToken.value === 'allowedFilters') {
          allowedFilters = this.parseStringArrayValues();
        } else if (keyToken.value === 'sourceSystems') {
          sourceSystems = this.parseStringArrayValues();
        } else if (keyToken.value === 'replacementFor') {
          replacementFor = this.parseStringArrayValues();
        }
      } else if (this.check(TokenType.ParamsKeyword)) {
        params = this.parseBlockParams();
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'parameterPolicy'
      ) {
        parameterPolicy = this.parseBlockParameterPolicy();
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'filterBindings'
      ) {
        filterBindings = this.parseBlockFilterBindings();
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'metricMappings'
        && this.tokens[this.pos + 1]?.type === TokenType.LeftBrace
      ) {
        metricMappings = this.parseBlockMetricMappings();
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'fields'
        && this.tokens[this.pos + 1]?.type === TokenType.LeftBrace
      ) {
        datasetFields = this.parseBlockDatasetFields();
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'measures'
        && this.tokens[this.pos + 1]?.type === TokenType.LeftBrace
      ) {
        datasetMeasures = this.parseBlockDatasetMeasures();
      } else if (this.check(TokenType.QueryKeyword)) {
        this.advance();
        if (this.check(TokenType.LeftBrace)) {
          query = this.parseLegacyBlockQuerySection();
        } else {
          this.expect(TokenType.Equals);
          if (this.check(TokenType.TripleQuoteString)) {
            const sqlToken = this.advance();
            const interpolations = this.extractInterpolations(sqlToken.value, sqlToken.span);
            query = {
              kind: NodeKind.SQLQuery,
              rawSQL: sqlToken.value,
              interpolations,
              span: sqlToken.span,
            };
          } else {
            // Fallback: parse as inline SQL
            query = this.parseSQLQuery();
          }
        }
      } else if (this.check(TokenType.VisualizationKeyword)) {
        visualization = this.parseBlockVisualization();
      } else if (this.check(TokenType.TestsKeyword)) {
        tests = this.parseBlockTests();
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'status'
      ) {
        // Block certification status. Recognised values come from BlockStatus
        // ('draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification').
        // Identifier-keyed to avoid a new lexer keyword.
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        status = val.value;
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'replacedBy' || this.current().value === 'deprecatedOn')
      ) {
        // Retirement metadata. Identifier-keyed to avoid new lexer keywords.
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        if (keyToken.value === 'replacedBy') {
          replacedBy = val.value.trim() || undefined;
        } else {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(val.value.trim())) {
            this.reporter.warning(
              `deprecatedOn should be a date in YYYY-MM-DD form, got "${val.value}".`,
              val.span,
            );
          }
          deprecatedOn = val.value.trim() || undefined;
        }
      } else if (
        this.check(TokenType.Identifier)
        && this.current().value === 'datalex_contract'
      ) {
        // DataLex contract reference: <domain>.<Entity>.<contract_name>[@version].
        // Resolved by the semantic analyzer against the project's DataLex
        // manifest. Identifier-keyed to avoid a new lexer keyword.
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        datalexContract = val.value;
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'asked_times' || this.current().value === 'limit' || this.current().value === 'source_dql_limit')
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.NumberLiteral);
        if (keyToken.value === 'asked_times') {
          askedTimes = Number(val.value);
        } else if (keyToken.value === 'limit') {
          limit = Number(val.value);
        } else {
          sourceDqlLimit = Number(val.value);
        }
      } else if (
        this.check(TokenType.Identifier)
        && isDraftStringMetadataField(this.current().value)
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        switch (keyToken.value) {
          case 'first_asked':
            firstAsked = val.value;
            break;
          case 'last_asked':
            lastAsked = val.value;
            break;
          case 'proposed_contract_id':
            proposedContractId = val.value;
            break;
          case 'proposed_domain':
            proposedDomain = val.value;
            break;
          case 'proposed_entity':
            proposedEntity = val.value;
            break;
          case 'source_question':
            sourceQuestion = val.value;
            break;
          case 'source_block':
            sourceBlock = val.value;
            break;
          case 'source_dql_kind':
            sourceDqlKind = val.value;
            break;
          case 'source_dql_name':
            sourceDqlName = val.value;
            break;
          case 'source_dql_path':
            sourceDqlPath = val.value;
            break;
          case 'source_dql_hash':
            sourceDqlHash = val.value;
            break;
          case 'source_dql_time_dimension':
            sourceDqlTimeDimension = val.value;
            break;
          case 'source_dql_granularity':
            sourceDqlGranularity = val.value;
            break;
          case 'followup_kind':
            followupKind = val.value;
            break;
          case 'context_pack_id':
            contextPackId = val.value;
            break;
          case 'route_intent':
            routeIntent = val.value;
            break;
          case 'time_dimension':
            timeDimension = val.value;
            break;
          case 'granularity':
            granularity = val.value;
            break;
          case 'draft_path':
            draftPath = val.value;
            break;
          case 'dataset_tile_provenance': {
            const parsed = this.parseDatasetProvenanceMetadata(val.value);
            if (!parsed.datasetTileProvenance) this.error('dataset_tile_provenance must contain a valid DatasetTileProvenanceV1 JSON object.');
            else datasetTileProvenance = parsed.datasetTileProvenance;
            break;
          }
          case 'derived_from': {
            const parsed = this.parseDatasetProvenanceMetadata(val.value);
            if (!parsed.datasetTileProvenance) this.error('derived_from must contain a valid DatasetTileProvenanceV1 JSON object.');
            else derivedFrom = parsed.datasetTileProvenance;
            break;
          }
          case 'semantic_tile_conversion_provenance': {
            const parsed = this.parseDatasetProvenanceMetadata(val.value);
            if (!parsed.semanticTileConversionProvenance) this.error('semantic_tile_conversion_provenance must contain a valid SemanticTileConversionProvenanceV1 JSON object.');
            else semanticTileConversionProvenance = parsed.semanticTileConversionProvenance;
            break;
          }
        }
      } else if (
        this.check(TokenType.Identifier)
        && isDraftArrayMetadataField(this.current().value)
      ) {
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        const values = this.parseStringArrayValues();
        switch (keyToken.value) {
          case 'upstream_refs':
            upstreamRefs = values;
            break;
          case 'requested_filters':
            requestedFilters = values;
            break;
          case 'requested_dimensions':
            requestedDimensions = values;
            break;
          case 'order_by':
            orderBy = values;
            break;
          case 'source_dql_metrics':
            sourceDqlMetrics = values;
            break;
          case 'source_dql_dimensions':
            sourceDqlDimensions = values;
            break;
          case 'source_dql_filters':
            sourceDqlFilters = values;
            break;
          case 'source_dql_order_by':
            sourceDqlOrderBy = values;
            break;
          case 'validation_warnings':
            validationWarnings = values;
            break;
        }
      } else if (
        this.check(TokenType.Identifier)
        && (this.current().value === 'llmContext'
          || this.current().value === 'invariants'
          || this.current().value === 'examples'
          || this.current().value === 'businessOutcome'
          || this.current().value === 'businessOwner'
          || this.current().value === 'decisionUse'
          || this.current().value === 'reviewCadence'
          || this.current().value === 'businessRules'
          || this.current().value === 'caveats'
          || this.current().value === 'synonyms'
          || this.current().value === 'primaryTerms')
      ) {
        // Agent-facing metadata. Identifier-keyed to avoid new lexer keywords.
        const keyToken = this.advance();
        this.expect(TokenType.Equals);
        if (keyToken.value === 'llmContext') {
          const val = this.expect(TokenType.StringLiteral);
          llmContext = val.value;
        } else if (keyToken.value === 'invariants') {
          const arrExpr = this.parseArrayLiteral();
          if (arrExpr.kind === NodeKind.ArrayLiteral) {
            invariants = arrExpr.elements
              .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
              .map((e) => e.value);
          }
        } else if (keyToken.value === 'examples') {
          // examples: [ { question = "...", sql = "..." }, ... ]
          this.expect(TokenType.LeftBracket);
          const items: Array<{ question: string; sql?: string }> = [];
          while (!this.check(TokenType.RightBracket) && !this.isAtEnd()) {
            this.expect(TokenType.LeftBrace);
            let question: string | undefined;
            let sql: string | undefined;
            while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
              const propToken = this.current();
              if (propToken.type !== TokenType.Identifier) {
                this.error(`Expected 'question' or 'sql' in example entry, got '${propToken.value}'.`);
                this.advance();
                continue;
              }
              this.advance();
              this.expect(TokenType.Equals);
              const val = this.expect(TokenType.StringLiteral);
              if (propToken.value === 'question') question = val.value;
              else if (propToken.value === 'sql') sql = val.value;
              if (this.check(TokenType.Comma)) this.advance();
            }
            this.expect(TokenType.RightBrace);
            if (question) items.push(sql ? { question, sql } : { question });
            if (this.check(TokenType.Comma)) this.advance();
          }
          this.expect(TokenType.RightBracket);
          if (items.length > 0) examples = items;
        } else if (keyToken.value === 'businessOutcome') {
          const val = this.expect(TokenType.StringLiteral);
          businessOutcome = val.value;
        } else if (keyToken.value === 'businessOwner') {
          const val = this.expect(TokenType.StringLiteral);
          businessOwner = val.value;
        } else if (keyToken.value === 'decisionUse') {
          const val = this.expect(TokenType.StringLiteral);
          decisionUse = val.value;
        } else if (keyToken.value === 'reviewCadence') {
          const val = this.expect(TokenType.StringLiteral);
          reviewCadence = val.value;
        } else if (keyToken.value === 'businessRules') {
          const arrExpr = this.parseArrayLiteral();
          if (arrExpr.kind === NodeKind.ArrayLiteral) {
            businessRules = arrExpr.elements
              .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
              .map((e) => e.value);
          }
        } else if (keyToken.value === 'caveats') {
          // One rule may be written as a plain string; it reads as a one-item list.
          if (this.check(TokenType.StringLiteral)) {
            caveats = [this.advance().value];
          } else {
            const arrExpr = this.parseArrayLiteral();
            if (arrExpr.kind === NodeKind.ArrayLiteral) {
              caveats = arrExpr.elements
                .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
                .map((e) => e.value);
            }
          }
        } else if (keyToken.value === 'synonyms') {
          synonyms = this.parseStringArrayValues();
        } else if (keyToken.value === 'primaryTerms') {
          primaryTerms = this.parseStringArrayValues();
        }
      } else {
        if (
          this.check(TokenType.Identifier)
          && this.tokens[this.pos + 1]?.type === TokenType.LeftBrace
        ) {
          const section = this.current().value;
          this.error(
            `Unexpected nested section '${section}' inside block. Unknown block sections are skipped during parse recovery.`,
          );
          this.advance();
          this.skipBalancedBlock();
          continue;
        }
        this.error(
          `Unexpected token '${this.current().value}' inside block. Expected 'domain', 'type', 'status', 'datalex_contract', 'metric', 'metrics', 'dimensions', 'description', 'tags', 'owner', 'terms', 'pattern', 'grain', 'fields', 'measures', 'entities', 'outputs', 'allowedFilters', 'parameterPolicy', 'filterBindings', 'metricMappings', 'sourceSystems', 'replacementFor', 'params', 'query', 'visualization', 'tests', 'llmContext', 'invariants', 'examples', 'businessOutcome', 'businessOwner', 'decisionUse', 'reviewCadence', 'businessRules', 'caveats', 'synonyms', 'primaryTerms', 'replacedBy', 'deprecatedOn', Tier-2 draft metadata fields, or '}'.`,
        );
        this.advance();
      }
    }

    if (!blockType) {
      blockType = 'custom';
      this.reporter.warning(
        `Block "${nameToken.value}" is missing a type declaration. DQL treated it as type = "custom" for backward compatibility.`,
        nameToken.span,
      );
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BlockDecl,
      name: nameToken.value,
      domain,
      blockType,
      metricRef,
      metricsRef,
      dimensionsRef: blockType === 'semantic' ? parsedDimensions : undefined,
      description,
      tags,
      owner,
      termRefs,
      pattern,
      datasetGrain,
      datasetFields,
      datasetMeasures,
      grain,
      entities,
      outputs,
      dimensions: blockType === 'semantic' ? undefined : parsedDimensions,
      allowedFilters,
      parameterPolicy,
      filterBindings,
      metricMappings,
      sourceSystems,
      replacementFor,
      params,
      query,
      visualization,
      tests,
      decorators,
      llmContext,
      invariants,
      examples,
      businessOutcome,
      businessOwner,
      decisionUse,
      reviewCadence,
      businessRules,
      caveats,
      synonyms,
      primaryTerms,
      status,
      replacedBy,
      deprecatedOn,
      datalexContract,
      askedTimes,
      firstAsked,
      lastAsked,
      proposedContractId,
      proposedDomain,
      proposedEntity,
      sourceQuestion,
      sourceBlock,
      sourceDqlKind,
      sourceDqlName,
      sourceDqlPath,
      sourceDqlHash,
      sourceDqlTimeDimension,
      sourceDqlGranularity,
      followupKind,
      contextPackId,
      routeIntent,
      timeDimension,
      granularity,
      draftPath,
      upstreamRefs,
      requestedFilters,
      requestedDimensions,
      orderBy,
      limit,
      sourceDqlMetrics,
      sourceDqlDimensions,
      sourceDqlFilters,
      sourceDqlOrderBy,
      sourceDqlLimit,
      validationWarnings,
      datasetTileProvenance,
      derivedFrom,
      semanticTileConversionProvenance,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseDatasetProvenanceMetadata(value: string): {
    datasetTileProvenance?: BlockDeclNode['datasetTileProvenance'];
    semanticTileConversionProvenance?: BlockDeclNode['semanticTileConversionProvenance'];
  } {
    try {
      const parsed = JSON.parse(value) as unknown;
      return {
        datasetTileProvenance: normalizeDatasetTileProvenance(parsed),
        semanticTileConversionProvenance: normalizeSemanticTileConversionProvenance(parsed),
      };
    } catch {
      return {};
    }
  }

  private parseLegacyBlockQuerySection(): SQLQueryNode | undefined {
    const start = this.currentSpan();
    this.expect(TokenType.LeftBrace);
    let query: SQLQueryNode | undefined;

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.Identifier) && this.current().value === 'sql') {
        this.advance();
        this.expect(TokenType.Equals);
        if (this.check(TokenType.TripleQuoteString)) {
          const sqlToken = this.advance();
          const interpolations = this.extractInterpolations(sqlToken.value, sqlToken.span);
          query = {
            kind: NodeKind.SQLQuery,
            rawSQL: sqlToken.value,
            interpolations,
            span: sqlToken.span,
          };
        } else {
          query = this.parseSQLQuery();
        }
      } else if (
        this.check(TokenType.Identifier)
        && SQL_START_KEYWORDS.has(this.current().value.toUpperCase())
      ) {
        query = this.parseSQLQuery();
      } else {
        this.error(`Unexpected token '${this.current().value}' inside query section. Expected 'sql' or inline SQL.`);
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);
    if (!query) {
      this.reporter.error(
        'Query section must contain sql = """...""" or inline SQL.',
        this.makeSpan(start, this.previousSpan()),
      );
    }
    return query;
  }

  private parseBlockParams(): BlockParamsNode {
    const start = this.currentSpan();
    this.expect(TokenType.ParamsKeyword);
    this.expect(TokenType.LeftBrace);

    const paramEntries: BlockParamEntry[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const paramStart = this.currentSpan();
      const nameToken = this.current();
      if (nameToken.type === TokenType.Identifier || this.isBlockFieldKeyword(nameToken.type)) {
        this.advance();
      } else {
        this.error(`Expected parameter name, got '${nameToken.value}'.`);
        this.advance();
        continue;
      }
      let paramType: import('../ast/nodes.js').BlockParamType | undefined;
      if (this.check(TokenType.ColonToken)) {
        this.advance();
        const typeToken = this.expect(TokenType.Identifier);
        let renderedType = typeToken.value;
        if (this.check(TokenType.LeftBracket) && this.tokens[this.pos + 1]?.type === TokenType.RightBracket) {
          this.advance();
          this.advance();
          renderedType += '[]';
        }
        const validTypes = ['string', 'number', 'boolean', 'date', 'string[]', 'number[]', 'date[]'];
        if (validTypes.includes(renderedType)) {
          paramType = renderedType as import('../ast/nodes.js').BlockParamType;
        } else {
          this.error(`Invalid block parameter type '${renderedType}'. Valid types: ${validTypes.join(', ')}`);
        }
      }
      let initializer: import('../ast/nodes.js').ExpressionNode | undefined;
      if (this.check(TokenType.Equals)) {
        this.advance();
        initializer = this.parseExpression();
      }
      paramEntries.push({
        name: nameToken.value,
        paramType,
        initializer,
        span: this.makeSpan(paramStart, this.previousSpan()),
      });
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BlockParams,
      params: paramEntries,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseBlockParameterPolicy(): BlockDeclNode['parameterPolicy'] {
    const entries: NonNullable<BlockDeclNode['parameterPolicy']> = [];
    this.expect(TokenType.Identifier);
    this.expect(TokenType.LeftBrace);
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const entryStart = this.currentSpan();
      const nameToken = this.current();
      if (nameToken.type === TokenType.Identifier || this.isBlockFieldKeyword(nameToken.type)) {
        this.advance();
      } else {
        this.error(`Expected parameter name inside parameterPolicy, got '${nameToken.value}'.`);
        this.advance();
        continue;
      }
      this.expect(TokenType.Equals);
      const policy = this.expectStringLike();
      entries.push({
        name: nameToken.value,
        policy: policy.value,
        span: this.makeSpan(entryStart, this.previousSpan()),
      });
    }
    this.expect(TokenType.RightBrace);
    return entries;
  }

  private parseBlockFilterBindings(): BlockDeclNode['filterBindings'] {
    const entries: NonNullable<BlockDeclNode['filterBindings']> = [];
    this.expect(TokenType.Identifier);
    this.expect(TokenType.LeftBrace);
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const entryStart = this.currentSpan();
      const nameToken = this.current();
      if (nameToken.type === TokenType.Identifier || this.isBlockFieldKeyword(nameToken.type)) {
        this.advance();
      } else {
        this.error(`Expected business filter name inside filterBindings, got '${nameToken.value}'.`);
        this.advance();
        continue;
      }
      this.expect(TokenType.Equals);
      const binding = this.expectStringLike();
      entries.push({
        filter: nameToken.value,
        binding: binding.value,
        span: this.makeSpan(entryStart, this.previousSpan()),
      });
    }
    this.expect(TokenType.RightBrace);
    return entries;
  }

  private parseBlockMetricMappings(): NonNullable<BlockDeclNode['metricMappings']> {
    const entries: NonNullable<BlockDeclNode['metricMappings']> = [];
    this.expect(TokenType.Identifier);
    this.expect(TokenType.LeftBrace);
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.Comma)) { this.advance(); continue; }
      const entryStart = this.currentSpan();
      const output = this.consumeDatasetPropertyName('metricMappings');
      this.expect(TokenType.LeftBrace);
      let metric: string | undefined;
      let filter: string | undefined;
      while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
        if (this.check(TokenType.Comma)) { this.advance(); continue; }
        const property = this.consumeDatasetPropertyName(`metricMappings ${output.value}`);
        this.expect(TokenType.Equals);
        if (property.value === 'metric') metric = this.expectStringLike().value.trim();
        else if (property.value === 'filter') filter = this.expectStringLike().value.trim();
        else {
          this.error(`Unknown metricMappings property '${property.value}' on ${output.value}. Expected 'metric' or 'filter'.`);
          this.skipDatasetPropertyValue();
        }
      }
      this.expect(TokenType.RightBrace);
      if (!metric) this.error(`metricMappings entry ${output.value} requires metric.`);
      else entries.push({ output: output.value, metric, ...(filter ? { filter } : {}), span: this.makeSpan(entryStart, this.previousSpan()) });
    }
    this.expect(TokenType.RightBrace);
    return entries;
  }

  /**
   * Dataset object grain is intentionally parsed separately from legacy string
   * `grain = "customer_id"`.  Old AST/manifest consumers keep receiving the
   * string field, while dataset-aware consumers read this richer contract.
   */
  private parseBlockDatasetGrain(): NonNullable<BlockDeclNode['datasetGrain']> {
    this.expect(TokenType.LeftBrace);
    let entities: string[] = [];
    let keys: string[] = [];
    let keyEvidence: string | undefined;
    let description: string | undefined;
    let timeGrain: string | undefined;
    let timeBucketBy: string | undefined;
    let aggregate: boolean | undefined;
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.Comma)) { this.advance(); continue; }
      const property = this.consumeDatasetPropertyName('grain');
      this.expect(TokenType.Equals);
      switch (property.value) {
        case 'entities': entities = this.parseStringArrayValues(); break;
        case 'keys': keys = this.parseStringArrayValues(); break;
        case 'keyEvidence': keyEvidence = this.expectStringLike().value; break;
        case 'description': description = this.expectStringLike().value; break;
        case 'timeGrain': timeGrain = this.expectStringLike().value; break;
        case 'timeBucketBy': timeBucketBy = this.expectStringLike().value; break;
        case 'aggregate': {
          const value = this.expect(TokenType.BooleanLiteral);
          aggregate = value.value === 'true';
          break;
        }
        default:
          this.error(`Unknown dataset grain property '${property.value}'. Expected entities, keys, keyEvidence, description, timeGrain, timeBucketBy, or aggregate.`);
          this.skipDatasetPropertyValue();
      }
      if (this.check(TokenType.Comma)) this.advance();
    }
    this.expect(TokenType.RightBrace);
    if (entities.length === 0 || keys.length === 0) {
      this.error('Dataset grain requires non-empty entities and keys arrays.');
    }
    return { entities, keys, keyEvidence, description, timeGrain, timeBucketBy, aggregate };
  }

  private parseBlockDatasetFields(): NonNullable<BlockDeclNode['datasetFields']> {
    this.expect(TokenType.Identifier); // fields
    this.expect(TokenType.LeftBrace);
    const entries: NonNullable<BlockDeclNode['datasetFields']> = [];
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.Comma)) { this.advance(); continue; }
      const name = this.consumeDatasetPropertyName('fields');
      this.expect(TokenType.LeftBrace);
      let role: NonNullable<BlockDeclNode['datasetFields']>[number]['role'] | undefined;
      let type: NonNullable<BlockDeclNode['datasetFields']>[number]['type'] | undefined;
      let grains: string[] | undefined;
      let primary: boolean | undefined;
      let hierarchy: string | undefined;
      let level: number | undefined;
      let status: 'approved' | 'suggested' | undefined;
      while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
        if (this.check(TokenType.Comma)) { this.advance(); continue; }
        const property = this.consumeDatasetPropertyName(`field ${name.value}`);
        this.expect(TokenType.Equals);
        if (property.value === 'role') {
          const value = this.expectStringLike().value;
          if (value === 'dimension' || value === 'key' || value === 'time' || value === 'attribute') role = value;
          else this.error(`Dataset field ${name.value} has unsupported role '${value}'.`);
        } else if (property.value === 'type') {
          const value = this.expectStringLike().value;
          if (value === 'string' || value === 'number' || value === 'boolean' || value === 'date' || value === 'timestamp') type = value;
          else this.error(`Dataset field ${name.value} has unsupported type '${value}'.`);
        } else if (property.value === 'grains') {
          grains = this.parseStringArrayValues();
        } else if (property.value === 'primary') {
          primary = this.expect(TokenType.BooleanLiteral).value === 'true';
        } else if (property.value === 'hierarchy') {
          hierarchy = this.expectStringLike().value;
        } else if (property.value === 'level') {
          level = Number(this.expect(TokenType.NumberLiteral).value);
        } else if (property.value === 'status') {
          const value = this.expectStringLike().value;
          if (value === 'approved' || value === 'suggested') status = value;
          else this.error(`Dataset field ${name.value} has unsupported status '${value}'.`);
        } else {
          this.error(`Unknown dataset field property '${property.value}' on ${name.value}.`);
          this.skipDatasetPropertyValue();
        }
        if (this.check(TokenType.Comma)) this.advance();
      }
      this.expect(TokenType.RightBrace);
      if (!role) this.error(`Dataset field ${name.value} requires role.`);
      else entries.push({ name: name.value, role, type, grains, primary, hierarchy, level, status });
      if (this.check(TokenType.Comma)) this.advance();
    }
    this.expect(TokenType.RightBrace);
    return entries;
  }

  private parseBlockDatasetMeasures(): NonNullable<BlockDeclNode['datasetMeasures']> {
    this.expect(TokenType.Identifier); // measures
    this.expect(TokenType.LeftBrace);
    const entries: NonNullable<BlockDeclNode['datasetMeasures']> = [];
    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.Comma)) { this.advance(); continue; }
      const name = this.consumeDatasetPropertyName('measures');
      this.expect(TokenType.LeftBrace);
      let aggregation: NonNullable<BlockDeclNode['datasetMeasures']>[number]['aggregation'] | undefined;
      let from: string | undefined;
      let numerator: string | undefined;
      let denominator: string | undefined;
      let expression: string | undefined;
      let timeBucketBy: string | undefined;
      let additive: NonNullable<BlockDeclNode['datasetMeasures']>[number]['additive'] | undefined;
      let entityAdditive: NonNullable<BlockDeclNode['datasetMeasures']>[number]['entityAdditive'] | undefined;
      let allowedAggs: NonNullable<BlockDeclNode['datasetMeasures']>[number]['allowedAggs'] | undefined;
      let format: NonNullable<BlockDeclNode['datasetMeasures']>[number]['format'] | undefined;
      let currency: string | undefined;
      let status: 'approved' | 'suggested' | undefined;
      while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
        if (this.check(TokenType.Comma)) { this.advance(); continue; }
        const property = this.consumeDatasetPropertyName(`measure ${name.value}`);
        this.expect(TokenType.Equals);
        if (property.value === 'agg') {
          const value = this.expectStringLike().value;
          if (value === 'sum' || value === 'count' || value === 'count_distinct' || value === 'ratio' || value === 'avg' || value === 'min' || value === 'max') aggregation = value;
          else this.error(`Dataset measure ${name.value} has unsupported agg '${value}'.`);
        } else if (property.value === 'from') {
          from = this.expectStringLike().value;
        } else if (property.value === 'numerator') {
          numerator = this.expectStringLike().value;
        } else if (property.value === 'denominator') {
          denominator = this.expectStringLike().value;
        } else if (property.value === 'expression') {
          expression = this.expectStringLike().value;
        } else if (property.value === 'timeBucketBy') {
          timeBucketBy = this.expectStringLike().value;
        } else if (property.value === 'additive') {
          const value = this.expectStringLike().value;
          if (value === 'additive' || value === 'semi_additive' || value === 'non_additive') additive = value;
          else this.error(`Dataset measure ${name.value} has unsupported additive value '${value}'.`);
        } else if (property.value === 'entityAdditive') {
          const value = this.expectStringLike().value;
          if (value === 'additive' || value === 'semi_additive' || value === 'non_additive') entityAdditive = value;
          else this.error(`Dataset measure ${name.value} has unsupported entityAdditive value '${value}'.`);
        } else if (property.value === 'allowedAggs') {
          const values = this.parseStringArrayValues();
          const valid = values.filter((value): value is NonNullable<BlockDeclNode['datasetMeasures']>[number]['aggregation'] => value === 'sum' || value === 'count' || value === 'count_distinct' || value === 'ratio' || value === 'avg' || value === 'min' || value === 'max');
          if (valid.length !== values.length) this.error(`Dataset measure ${name.value} allowedAggs contains an unsupported aggregation.`);
          allowedAggs = valid;
        } else if (property.value === 'format') {
          const value = this.expectStringLike().value;
          if (value === 'number' || value === 'currency' || value === 'percent') format = value;
          else this.error(`Dataset measure ${name.value} has unsupported format '${value}'.`);
        } else if (property.value === 'currency') {
          currency = this.expectStringLike().value;
        } else if (property.value === 'status') {
          const value = this.expectStringLike().value;
          if (value === 'approved' || value === 'suggested') status = value;
          else this.error(`Dataset measure ${name.value} has unsupported status '${value}'.`);
        } else {
          this.error(`Unknown dataset measure property '${property.value}' on ${name.value}.`);
          this.skipDatasetPropertyValue();
        }
        if (this.check(TokenType.Comma)) this.advance();
      }
      this.expect(TokenType.RightBrace);
      if (!aggregation || !additive) this.error(`Dataset measure ${name.value} requires agg and additive.`);
      else if (expression && (from || numerator || denominator)) this.error(`Calculated Dataset measure ${name.value} cannot combine expression with from, numerator, or denominator.`);
      else if (!expression && aggregation === 'ratio' && (!numerator || !denominator)) this.error(`Dataset ratio ${name.value} requires numerator and denominator.`);
      else if (!expression && aggregation !== 'ratio' && !from) this.error(`Dataset measure ${name.value} requires from.`);
      else entries.push({ name: name.value, aggregation, from, numerator, denominator, expression, timeBucketBy, additive, entityAdditive, allowedAggs, format, currency, status });
      if (this.check(TokenType.Comma)) this.advance();
    }
    this.expect(TokenType.RightBrace);
    return entries;
  }

  private consumeDatasetPropertyName(context: string): Token {
    const token = this.current();
    if (token.type === TokenType.RightBrace || token.type === TokenType.Equals || token.type === TokenType.Comma || token.type === TokenType.EOF) {
      this.error(`Expected a property name inside ${context}, got '${token.value}'.`);
      return this.advance();
    }
    return this.advance();
  }

  private skipDatasetPropertyValue(): void {
    if (this.check(TokenType.LeftBrace)) {
      this.skipBalancedBlock();
      return;
    }
    if (this.check(TokenType.LeftBracket)) {
      this.advance();
      let depth = 1;
      while (depth > 0 && !this.isAtEnd()) {
        if (this.check(TokenType.LeftBracket)) depth += 1;
        if (this.check(TokenType.RightBracket)) depth -= 1;
        this.advance();
      }
      return;
    }
    this.advance();
  }

  private parseBlockVisualization(): BlockVisualizationNode {
    const start = this.currentSpan();
    this.expect(TokenType.VisualizationKeyword);
    this.expect(TokenType.LeftBrace);

    const properties: NamedArgNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const propStart = this.currentSpan();
      const nameToken = this.current();
      if (nameToken.type === TokenType.Identifier || this.isBlockFieldKeyword(nameToken.type)) {
        this.advance();
      } else {
        this.error(`Expected property name, got '${nameToken.value}'.`);
        this.advance();
        continue;
      }
      this.expect(TokenType.Equals);
      const value = this.parseExpression();
      properties.push({
        kind: NodeKind.NamedArg,
        name: nameToken.value,
        value,
        span: this.makeSpan(propStart, this.previousSpan()),
      });
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BlockVisualization,
      properties,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseBlockTests(): BlockTestNode[] {
    const start = this.currentSpan();
    this.expect(TokenType.TestsKeyword);
    this.expect(TokenType.LeftBrace);

    const testNodes: BlockTestNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.AssertKeyword)) {
        const assertStart = this.currentSpan();
        this.advance(); // consume 'assert'

        const fieldToken = this.current();
        if (fieldToken.type === TokenType.Identifier || this.isBlockFieldKeyword(fieldToken.type)) {
          this.advance();
        } else {
          this.error(`Expected field name after 'assert', got '${fieldToken.value}'.`);
          this.advance();
          continue;
        }

        // Parse operator
        let operator: BlockTestNode['operator'];
        if (this.check(TokenType.GreaterThan)) {
          this.advance();
          operator = '>';
        } else if (this.check(TokenType.LessThan)) {
          this.advance();
          operator = '<';
        } else if (this.check(TokenType.GreaterThanOrEqual)) {
          this.advance();
          operator = '>=';
        } else if (this.check(TokenType.LessThanOrEqual)) {
          this.advance();
          operator = '<=';
        } else if (this.check(TokenType.DoubleEquals)) {
          this.advance();
          operator = '==';
        } else if (this.check(TokenType.NotEquals)) {
          this.advance();
          operator = '!=';
        } else if (this.check(TokenType.InKeyword)) {
          this.advance();
          operator = 'IN';
        } else {
          this.error(`Expected comparison operator (>, <, >=, <=, ==, !=, IN) after field name, got '${this.current().value}'.`);
          this.advance();
          continue;
        }

        const expected = this.parseExpression();

        testNodes.push({
          kind: NodeKind.BlockTest,
          field: fieldToken.value,
          operator,
          expected,
          span: this.makeSpan(assertStart, this.previousSpan()),
        });
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(`Unexpected token '${this.current().value}' inside tests. Expected 'assert' or '}'.`);
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return testNodes;
  }

  private isBlockFieldKeyword(type: TokenType): boolean {
    return type === TokenType.DomainKeyword
      || type === TokenType.TypeKeyword
      || type === TokenType.MetricKeyword
      || type === TokenType.DescriptionKeyword
      || type === TokenType.TagsKeyword
      || type === TokenType.OwnerKeyword
      || type === TokenType.TermsKeyword
      || type === TokenType.ChartKeyword
      || type === TokenType.QueryKeyword
      || type === TokenType.DefaultKeyword
      || type === TokenType.FromKeyword;
  }

  // ---- Workbook / Page ----

  private parseWorkbook(decorators: DecoratorNode[]): WorkbookNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.WorkbookKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const pages: PageNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.PageKeyword)) {
        pages.push(this.parsePage());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside workbook. Expected 'page' or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Workbook,
      title: titleToken.value,
      decorators,
      pages,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parsePage(): PageNode {
    const start = this.currentSpan();
    this.expect(TokenType.PageKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const body: DashboardBodyItem[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const itemDecorators = this.parseDecoratorList();

      if (this.check(TokenType.LetKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to variable declarations.');
        }
        body.push(this.parseVariableDecl());
      } else if (this.check(TokenType.ParamKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to param declarations.');
        }
        body.push(this.parseParamDecl());
      } else if (this.check(TokenType.ChartKeyword)) {
        body.push(this.parseChartCall(itemDecorators));
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        body.push(this.parseFilterCall());
      } else if (this.check(TokenType.UseKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to use declarations.');
        }
        body.push(this.parseUseDecl());
      } else if (this.check(TokenType.LayoutKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to layout blocks.');
        }
        body.push(this.parseLayoutBlock());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside page. Expected 'let', 'param', 'chart', 'filter', 'use', 'layout', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Page,
      title: titleToken.value,
      body,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Param Declaration ----

  private parseParamDecl(): ParamDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.ParamKeyword);

    const nameToken = this.expect(TokenType.Identifier);

    // Optional type annotation: param name: type
    let paramType: ParamType = 'string';
    if (this.check(TokenType.ColonToken)) {
      this.advance(); // consume ':'
      const typeToken = this.expect(TokenType.Identifier);
      const validTypes = ['string', 'number', 'boolean', 'date'];
      if (validTypes.includes(typeToken.value)) {
        paramType = typeToken.value as ParamType;
      } else {
        this.reporter.error(
          `Invalid param type '${typeToken.value}'. Valid types: ${validTypes.join(', ')}`,
          typeToken.span,
        );
      }
    }

    // Optional default value: = expression
    let defaultValue: ExpressionNode | undefined;
    if (this.check(TokenType.Equals)) {
      this.advance(); // consume '='
      defaultValue = this.parseExpression();
    }

    return {
      kind: NodeKind.ParamDecl,
      name: nameToken.value,
      paramType,
      defaultValue,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Import / Use ----

  private parseImportDecl(): ImportDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.ImportKeyword);

    // import { name1, name2 } from "path"
    this.expect(TokenType.LeftBrace);

    const names: string[] = [];
    if (!this.check(TokenType.RightBrace)) {
      names.push(this.expect(TokenType.Identifier).value);
      while (this.check(TokenType.Comma)) {
        this.advance();
        if (this.check(TokenType.RightBrace)) break; // trailing comma
        names.push(this.expect(TokenType.Identifier).value);
      }
    }

    this.expect(TokenType.RightBrace);
    this.expect(TokenType.FromKeyword);

    const pathToken = this.expect(TokenType.StringLiteral);

    return {
      kind: NodeKind.ImportDecl,
      names,
      path: pathToken.value,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseUseDecl(): UseDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.UseKeyword);

    let nameToken: Token;
    if (this.check(TokenType.Identifier) || this.check(TokenType.StringLiteral)) {
      nameToken = this.advance();
    } else {
      nameToken = this.expect(TokenType.Identifier);
    }

    return {
      kind: NodeKind.UseDecl,
      name: nameToken.value,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Layout ----

  private parseLayoutBlock(): LayoutBlockNode {
    const start = this.currentSpan();
    this.expect(TokenType.LayoutKeyword);

    // Optional: layout(columns = 12)
    let columns = 12;
    if (this.check(TokenType.LeftParen)) {
      this.advance();
      const args: NamedArgNode[] = [];
      if (!this.check(TokenType.RightParen)) {
        args.push(this.parseNamedArg());
        while (this.check(TokenType.Comma)) {
          this.advance();
          if (this.check(TokenType.RightParen)) break;
          args.push(this.parseNamedArg());
        }
      }
      this.expect(TokenType.RightParen);

      const colArg = args.find((a) => a.name === 'columns');
      if (colArg && colArg.value.kind === NodeKind.NumberLiteral) {
        columns = colArg.value.value;
      }
    }

    this.expect(TokenType.LeftBrace);

    const rows: LayoutRowNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.RowKeyword)) {
        rows.push(this.parseLayoutRow());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside layout. Expected 'row' or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.LayoutBlock,
      columns,
      rows,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseLayoutRow(): LayoutRowNode {
    const start = this.currentSpan();
    this.expect(TokenType.RowKeyword);
    this.expect(TokenType.LeftBrace);

    const items: LayoutRowItem[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const itemDecorators = this.parseDecoratorList();

      let node: ChartCallNode | FilterCallNode;
      if (this.check(TokenType.ChartKeyword)) {
        node = this.parseChartCall(itemDecorators);
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        node = this.parseFilterCall();
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside row. Expected 'chart', 'filter', or '}'.`,
        );
        this.advance();
        continue;
      }

      // Check for optional 'span N' after the chart/filter call
      let span: number | undefined;
      if (this.check(TokenType.Identifier) && this.current().value === 'span') {
        this.advance(); // consume 'span'
        const spanToken = this.expect(TokenType.NumberLiteral);
        span = Number(spanToken.value);
      }

      items.push({ node, span });
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.LayoutRow,
      items,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Helpers ----

  private synchronize(): void {
    while (!this.isAtEnd()) {
      const token = this.current();
      if (
        token.type === TokenType.DashboardKeyword ||
        token.type === TokenType.WorkbookKeyword ||
        token.type === TokenType.ChartKeyword ||
        token.type === TokenType.FilterKeyword ||
        token.type === TokenType.ImportKeyword ||
        token.type === TokenType.BlockKeyword ||
        token.type === TokenType.TermKeyword ||
        token.type === TokenType.BusinessViewKeyword ||
        token.type === TokenType.AtSign ||
        token.type === TokenType.RightBrace
      ) {
        return;
      }
      this.advance();
    }
  }
}

export function parse(source: string, file?: string): ProgramNode {
  const parser = new Parser(source, file);
  return parser.parse();
}
