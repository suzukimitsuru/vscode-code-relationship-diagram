; TypeScript / TSX の AST クエリ
;
; キャプチャ名の規約 (言語間で統一する事。docs/ast-plan.md §6.2):
;   def.<種別>             定義。fqn / export_name の元になる
;   def.<種別>.signature   本体の無い宣言 (オーバーロード・宣言ファイル)。同じ親・同じ名前の定義と1つにまとめる
;   def.<種別>.parameter   コンストラクタ引数のプロパティ。親をコンストラクタの1つ外側 (クラス) にする
;   def.node               定義ノードを明示する (省略時は名前ノードの親が定義ノード)
;   imp.local              import 束縛のファイル内での名前 (1マッチ = 1束縛)
;   imp.imported           取り込む名前 (名前付き import / 再エクスポート)
;   imp.default            default import (imp.local と同じノード)
;   imp.namespace          namespace import (imp.local と同じノード)
;   imp.export             再エクスポートで公開する名前 (export { a as b } from の b)
;   imp.reexport           export * from の文全体 (公開名 '*')
;   imp.module             モジュール指定子
;   imp.module.bare        束縛の無い import / require (他のマッチが同じ指定子を使っていなければ副作用 import)
;   imp.require            require の関数名 (参照出現から除外する)
;   export.statement       export 文 (直下の宣言が export される)
;   export.default         export default 文
;   export.local / export.name   export { local as name } (from 無し)
;   export.default.local   export default <識別子>
;   scope                  レキシカルスコープを作るノード
;   bind.<種別>            定義以外の束縛 (引数・型引数・分割代入・catch 等)
;   ref.<kind>             参照出現。<kind> がそのまま RelationshipKind になる
;   ref.receiver           メンバ参照のレシーバ (a.b() の a、this / super、A.B.c() の A.B のようなメンバ参照の連鎖)
;
; def / bind / imp にキャプチャされたノードは参照出現にならない。
; 同じノードを複数の ref パターンが捉えた時は relationshipKind.ts の優先順位で1つに絞る。
;
; ------------------------------------------------------------------
; 定義
; ------------------------------------------------------------------
(class_declaration name: (type_identifier) @def.class)
(abstract_class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(type_alias_declaration name: (type_identifier) @def.type)
(enum_declaration name: (identifier) @def.enum)
(enum_body name: (property_identifier) @def.enum_member @def.node)
(enum_body (enum_assignment name: (property_identifier) @def.enum_member))
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(function_signature name: (identifier) @def.function.signature)
(method_definition name: (property_identifier) @def.method)
(class_body (method_signature name: (property_identifier) @def.method.signature))
(abstract_method_signature name: (property_identifier) @def.method.signature)
(public_field_definition name: (property_identifier) @def.property)
; コンストラクタ引数のプロパティ (constructor(public readonly x: T)) はクラスのメンバ。親はコンストラクタではなくクラスになる
(required_parameter (accessibility_modifier) pattern: (identifier) @def.property.parameter)
(required_parameter "readonly" pattern: (identifier) @def.property.parameter)
(optional_parameter (accessibility_modifier) pattern: (identifier) @def.property.parameter)
(optional_parameter "readonly" pattern: (identifier) @def.property.parameter)
; 型のメンバはインターフェースと型エイリアスの本体に限る
; (引数や戻り値の型注釈に書いた型リテラルのメンバは定義にしない)
(interface_body (method_signature name: (property_identifier) @def.method.signature))
(interface_body (property_signature name: (property_identifier) @def.property))
(type_alias_declaration value: (object_type (method_signature name: (property_identifier) @def.method.signature)))
(type_alias_declaration value: (object_type (property_signature name: (property_identifier) @def.property)))
(variable_declarator name: (identifier) @def.variable)
(module name: (identifier) @def.module)
(internal_module name: (identifier) @def.module)

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
(import_statement
  (import_require_clause (identifier) @imp.local @imp.namespace source: (string) @imp.module))
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
  (abstract_class_declaration)
  (class)
  (interface_declaration)
  (type_alias_declaration)
  (for_statement)
  (for_in_statement)
  (catch_clause)
] @scope

(required_parameter pattern: (identifier) @bind.parameter)
(optional_parameter pattern: (identifier) @bind.parameter)
(arrow_function parameter: (identifier) @bind.parameter)
(catch_clause parameter: (identifier) @bind.parameter)
(type_parameter name: (type_identifier) @bind.type_parameter)
(for_in_statement kind: _ left: (identifier) @bind.variable)
(shorthand_property_identifier_pattern) @bind.pattern
(pair_pattern value: (identifier) @bind.pattern)
(array_pattern (identifier) @bind.pattern)
(rest_pattern (identifier) @bind.pattern)
(assignment_pattern left: (identifier) @bind.pattern)

; ------------------------------------------------------------------
; 参照出現 (キャプチャ名がそのまま kind)
; ------------------------------------------------------------------

; kind = inheritance / implementation
(extends_clause value: (identifier) @ref.inheritance)
(extends_clause value: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.inheritance))
(extends_type_clause type: (type_identifier) @ref.inheritance)
(extends_type_clause type: (nested_type_identifier
  module: [(identifier) (nested_identifier)] @ref.receiver
  name: (type_identifier) @ref.inheritance))
(implements_clause (type_identifier) @ref.implementation)
(implements_clause (nested_type_identifier
  module: [(identifier) (nested_identifier)] @ref.receiver
  name: (type_identifier) @ref.implementation))

; kind = instantiation
(new_expression constructor: (identifier) @ref.instantiation)
(new_expression constructor: (member_expression
  object: [(identifier) (member_expression)] @ref.receiver
  property: (property_identifier) @ref.instantiation))

; kind = call
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression
  object: [(identifier) (this) (super) (member_expression)] @ref.receiver
  property: (property_identifier) @ref.call))

; kind = type_reference (型の位置に現れる型名は全て)
(type_identifier) @ref.type_reference
(nested_type_identifier
  module: [(identifier) (nested_identifier)] @ref.receiver
  name: (type_identifier) @ref.type_reference)

; kind = write
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (member_expression
  object: [(identifier) (this) (super) (member_expression)] @ref.receiver
  property: (property_identifier) @ref.write))
(augmented_assignment_expression left: (identifier) @ref.write)
(augmented_assignment_expression left: (member_expression
  object: [(identifier) (this) (super) (member_expression)] @ref.receiver
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
  object: [(identifier) (this) (super) (member_expression)] @ref.receiver
  property: (property_identifier) @ref.read)
(identifier) @ref.read
(shorthand_property_identifier) @ref.read
