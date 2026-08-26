; TypeScript / TSX の AST クエリ
;
; キャプチャ名の規約 (言語間で統一する事):
;   def.<種別>        定義。fqn / export_name の元になる
;   imp.name          import 束縛のローカル名
;   imp.alias         import 束縛の別名 (as の右辺)
;   imp.default       default import の束縛名
;   imp.namespace     namespace import (* as X) の束縛名
;   imp.module        モジュール指定子の文字列
;   ref.<kind>        参照出現。<kind> がそのまま RelationshipKind になる
;   ref.receiver      メンバ参照のレシーバ (a.b() の a)
;
; ------------------------------------------------------------------
; 定義
; ------------------------------------------------------------------
(class_declaration name: (type_identifier) @def.class)
(abstract_class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(type_alias_declaration name: (type_identifier) @def.type)
(enum_declaration name: (identifier) @def.enum)
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(method_signature name: (property_identifier) @def.method)
(method_definition name: (property_identifier) @def.method)
(public_field_definition name: (property_identifier) @def.property)
(property_signature name: (property_identifier) @def.property)
(variable_declarator name: (identifier) @def.variable)
(module name: (identifier) @def.module)

; ------------------------------------------------------------------
; import 束縛
; ------------------------------------------------------------------
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @imp.name)))
  source: (string) @imp.module)
(import_statement
  (import_clause (named_imports (import_specifier alias: (identifier) @imp.alias)))
  source: (string) @imp.module)
(import_statement
  (import_clause (identifier) @imp.default)
  source: (string) @imp.module)
(import_statement
  (import_clause (namespace_import (identifier) @imp.namespace))
  source: (string) @imp.module)
; 副作用のみの import (束縛名なし)。束縛付き import では @imp.module と重複するため名前で区別する
(import_statement source: (string) @imp.module.bare)
(import_require_clause source: (string) @imp.module)
(call_expression
  function: (identifier) @imp.require.function
  arguments: (arguments (string) @imp.module)
  (#eq? @imp.require.function "require"))

; ------------------------------------------------------------------
; 再エクスポート (export ... from '...') / エクスポート名
; ------------------------------------------------------------------
(export_statement
  (export_clause (export_specifier name: (identifier) @def.export))
  source: (string) @imp.module)
(export_statement (export_clause (export_specifier name: (identifier) @def.export)))

; ------------------------------------------------------------------
; 参照出現 (キャプチャ名がそのまま kind)
; ------------------------------------------------------------------

; kind = inheritance / implementation
(extends_clause value: (identifier) @ref.inheritance)
(extends_clause value: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.inheritance))
(extends_type_clause type: (type_identifier) @ref.inheritance)
(implements_clause (type_identifier) @ref.implementation)

; kind = instantiation
(new_expression constructor: (identifier) @ref.instantiation)
(new_expression constructor: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.instantiation))

; kind = call
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.call))
; this / super をレシーバとする呼び出し (@ref.receiver の文字列が 'this' / 'super' になる)
(call_expression function: (member_expression
  object: [(this) (super)] @ref.receiver
  property: (property_identifier) @ref.call))

; kind = type_reference
(type_annotation (type_identifier) @ref.type_reference)
(type_annotation (generic_type name: (type_identifier) @ref.type_reference))
(type_arguments (type_identifier) @ref.type_reference)
(as_expression (type_identifier) @ref.type_reference)
(satisfies_expression (type_identifier) @ref.type_reference)
(type_predicate type: (type_identifier) @ref.type_reference)

; kind = write
(assignment_expression left: (identifier) @ref.write)
(assignment_expression left: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.write))
(assignment_expression left: (member_expression
  object: [(this) (super)] @ref.receiver
  property: (property_identifier) @ref.write))
(augmented_assignment_expression left: (identifier) @ref.write)

; kind = decorator
(decorator (identifier) @ref.decorator)
(decorator (call_expression function: (identifier) @ref.decorator))

; kind = read (上位のパターンに一致しなかった識別子)
(member_expression object: (identifier) @ref.read)
(member_expression
  object: [(this) (super)] @ref.receiver
  property: (property_identifier) @ref.read.member)
