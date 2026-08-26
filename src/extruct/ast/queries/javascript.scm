; JavaScript / JSX の AST クエリ
;
; キャプチャ名の規約は typescript.scm と共通。型に関する kind (type_reference /
; implementation) は JavaScript の文法に存在しないため定義しない。
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

; kind = inheritance
(class_heritage (identifier) @ref.inheritance)
(class_heritage (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.inheritance))

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
