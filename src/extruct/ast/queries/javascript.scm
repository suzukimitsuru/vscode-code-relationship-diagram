; JavaScript / JSX の AST クエリ
;
; キャプチャ名の規約は typescript.scm と共通。型に関する kind (type_reference /
; implementation) と型引数の束縛は JavaScript の文法に存在しないため定義しない。
;
; ------------------------------------------------------------------
; 定義
; ------------------------------------------------------------------
(class_declaration name: (identifier) @def.class)
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(method_definition name: (property_identifier) @def.method)
(field_definition property: (property_identifier) @def.property)
(variable_declarator name: (identifier) @def.variable)
; 引数と for-of の変数 (Stage 3: 型推論の手掛かり。言語サーバのシンボルには無い)
(formal_parameters (identifier) @def.parameter @def.node)
(arrow_function parameter: (identifier) @def.parameter @def.node)
(for_in_statement kind: _ left: (identifier) @def.variable @def.node)
; 分割代入で取り出した変数 (取り出し元の値のメンバから型を引く)
(variable_declarator name: (object_pattern (shorthand_property_identifier_pattern) @def.variable @def.node))
(variable_declarator name: (object_pattern (object_assignment_pattern left: (shorthand_property_identifier_pattern) @def.variable @def.node)))
(variable_declarator name: (object_pattern (pair_pattern value: (identifier) @def.variable @def.node)))
(variable_declarator name: (object_pattern (pair_pattern value: (assignment_pattern left: (identifier) @def.variable @def.node))))

; ------------------------------------------------------------------
; import 束縛 (1マッチ = 1束縛)
; ------------------------------------------------------------------
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @imp.imported @imp.local !alias)))
  source: (string) @imp.module)
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @imp.imported alias: (identifier) @imp.local)))
  source: (string) @imp.module)
(import_statement
  (import_clause (identifier) @imp.local @imp.default)
  source: (string) @imp.module)
(import_statement
  (import_clause (namespace_import (identifier) @imp.local @imp.namespace))
  source: (string) @imp.module)
(variable_declarator
  name: (identifier) @imp.local @imp.namespace
  value: (call_expression function: (identifier) @imp.require arguments: (arguments (string) @imp.module))
  (#eq? @imp.require "require"))
(variable_declarator
  name: (object_pattern (shorthand_property_identifier_pattern) @imp.imported @imp.local)
  value: (call_expression function: (identifier) @imp.require arguments: (arguments (string) @imp.module))
  (#eq? @imp.require "require"))
(variable_declarator
  name: (object_pattern (pair_pattern key: (property_identifier) @imp.imported value: (identifier) @imp.local))
  value: (call_expression function: (identifier) @imp.require arguments: (arguments (string) @imp.module))
  (#eq? @imp.require "require"))

; 束縛の無い import / require
(import_statement source: (string) @imp.module.bare)
(call_expression
  function: (identifier) @imp.require
  arguments: (arguments (string) @imp.module.bare)
  (#eq? @imp.require "require"))

; 再エクスポート (export ... from '...')
(export_statement
  (export_clause (export_specifier name: (identifier) @imp.imported @imp.export !alias))
  source: (string) @imp.module)
(export_statement
  (export_clause (export_specifier name: (identifier) @imp.imported alias: (identifier) @imp.export))
  source: (string) @imp.module)
(export_statement (namespace_export (identifier) @imp.export) source: (string) @imp.module)
(export_statement "*" source: (string) @imp.module) @imp.reexport

; ------------------------------------------------------------------
; export
; ------------------------------------------------------------------
(export_statement) @export.statement
(export_statement "default") @export.default
(export_statement (export_clause (export_specifier name: (identifier) @export.local @export.name !alias)) !source)
(export_statement (export_clause (export_specifier name: (identifier) @export.local alias: (identifier) @export.name)) !source)
(export_statement "default" value: (identifier) @export.default.local)

; ------------------------------------------------------------------
; スコープと束縛 (scope_id の算出に使う)
; ------------------------------------------------------------------
[
  (statement_block)
  (function_declaration)
  (generator_function_declaration)
  (function_expression)
  (generator_function)
  (arrow_function)
  (method_definition)
  (class_declaration)
  (class)
  (for_statement)
  (for_in_statement)
  (catch_clause)
] @scope

(formal_parameters (identifier) @bind.parameter)
(arrow_function parameter: (identifier) @bind.parameter)
(catch_clause parameter: (identifier) @bind.parameter)
(for_in_statement kind: _ left: (identifier) @bind.variable)
(shorthand_property_identifier_pattern) @bind.pattern
(pair_pattern value: (identifier) @bind.pattern)
(array_pattern (identifier) @bind.pattern)
(rest_pattern (identifier) @bind.pattern)
(assignment_pattern left: (identifier) @bind.pattern)

; ------------------------------------------------------------------
; 参照出現 (キャプチャ名がそのまま kind)
; ------------------------------------------------------------------

; kind = inheritance
(class_heritage (identifier) @ref.inheritance)
(class_heritage (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.inheritance))

; kind = instantiation
(new_expression constructor: (identifier) @ref.instantiation)
(new_expression constructor: (member_expression
  object: [(identifier) (member_expression)] @ref.receiver
  property: (property_identifier) @ref.instantiation))

; kind = call
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression
  object: [(identifier) (this) (super) (member_expression) (subscript_expression)] @ref.receiver
  property: (property_identifier) @ref.call))

; kind = write
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (member_expression
  object: [(identifier) (this) (super) (member_expression) (subscript_expression)] @ref.receiver
  property: (property_identifier) @ref.write))
(augmented_assignment_expression left: (identifier) @ref.write)
(augmented_assignment_expression left: (member_expression
  object: [(identifier) (this) (super) (member_expression) (subscript_expression)] @ref.receiver
  property: (property_identifier) @ref.write))

; kind = decorator
(decorator (identifier) @ref.decorator)
(decorator (call_expression function: (identifier) @ref.decorator))
(decorator (call_expression function: (member_expression
  object: [(identifier) (member_expression)] @ref.receiver
  property: (property_identifier) @ref.decorator)))

; kind = read (メンバの読み取りと、値として現れる識別子は全て)
; 素の識別子は包括的に捉える。定義名・束縛・import 名は除外され、呼び出し等のより具体的な種類が優先される。
; メンバ参照の連鎖 (A.B.c) の内側の識別子は、連鎖全体の参照出現に含まれるため除かれる
(member_expression
  object: [(identifier) (this) (super) (member_expression) (subscript_expression)] @ref.receiver
  property: (property_identifier) @ref.read)
(identifier) @ref.read
(shorthand_property_identifier) @ref.read

; ------------------------------------------------------------------
; オブジェクトリテラルのキー (kind = object_key)
; 文脈の型のプロパティへの参照。名前解決はせず、精度検証で構造的な参照を見分けるために記録する
; ------------------------------------------------------------------
(object (pair key: (property_identifier) @key.object))
(object (shorthand_property_identifier) @key.object)
(object (method_definition name: (property_identifier) @key.object))
