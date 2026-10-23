from __future__ import annotations

import csv
import io
import re
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

from app.features.artifacts.presentation import header_display_name

MAX_XLSX_ROWS = 1_048_576
MAX_XLSX_COLUMNS = 16_384
MAX_CELL_CHARS = 32_767
NUMBER_PATTERN = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")


class SpreadsheetExportError(ValueError):
    """The source is tabular but cannot be represented safely as an XLSX file."""


def _column_name(index: int) -> str:
    value = index
    result = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _xml_text(value: object) -> str:
    return escape(str(value), {"\r": "&#13;", "\n": "&#10;", "\t": "&#9;"})


def _coerce_cell(value: str) -> str | int | float | bool | None:
    text = value.strip()
    if not text:
        return None
    if text.lower() in {"true", "false"}:
        return text.lower() == "true"
    # Preserve identifiers such as 0012 and 00042 as text.
    if len(text) > 1 and text[0] == "0" and text[1].isdigit():
        return text
    if NUMBER_PATTERN.fullmatch(text):
        try:
            number = float(text)
        except ValueError:
            return text
        if number.is_integer() and not any(char in text.lower() for char in (".", "e")):
            return int(number)
        return number
    return text


def _parse_table(payload: bytes, media_type: str) -> list[list[str]]:
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SpreadsheetExportError("El archivo tabular no está codificado en UTF-8") from exc
    delimiter = "\t" if "tab-separated" in media_type.lower() else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        raise SpreadsheetExportError("El archivo tabular está vacío")
    width = max(len(row) for row in rows)
    if width > MAX_XLSX_COLUMNS:
        raise SpreadsheetExportError("El archivo tabular supera el límite de columnas de Excel")
    normalized = [row + [""] * (width - len(row)) for row in rows]
    headers = [header_display_name(header) for header in normalized[0]]
    seen: dict[str, int] = {}
    unique_headers: list[str] = []
    for header in headers:
        seen[header] = seen.get(header, 0) + 1
        unique_headers.append(header if seen[header] == 1 else f"{header} ({seen[header]})")
    normalized[0] = unique_headers
    return normalized


def _worksheet_columns(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    widths: list[int] = []
    for index in range(len(rows[0])):
        width = max((len(str(row[index])) for row in rows[:250]), default=10)
        widths.append(min(max(width + 2, 12), 42))
    parts = []
    for index, width in enumerate(widths, start=1):
        parts.append(f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>')
    return f"<cols>{''.join(parts)}</cols>"


def _worksheet_rows(rows: list[list[str]]) -> str:
    output: list[str] = []
    for row_index, row in enumerate(rows, start=1):
        cells: list[str] = []
        for column_index, raw_value in enumerate(row, start=1):
            value = _coerce_cell(raw_value) if row_index > 1 else raw_value
            if value is None:
                continue
            reference = f"{_column_name(column_index)}{row_index}"
            if isinstance(value, bool):
                cells.append(f'<c r="{reference}" s="2" t="b"><v>{int(value)}</v></c>')
            elif isinstance(value, (int, float)):
                cells.append(f'<c r="{reference}" s="2"><v>{value}</v></c>')
            else:
                text = str(value)[:MAX_CELL_CHARS]
                style = "1" if row_index == 1 else "3"
                cells.append(
                    f'<c r="{reference}" s="{style}" t="inlineStr">'
                    f"<is><t xml:space=\"preserve\">{_xml_text(text)}</t></is></c>"
                )
        output.append(f'<row r="{row_index}">{''.join(cells)}</row>')
    return "".join(output)


def _workbook_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Resultados" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )


def _styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="0"/>'
        '<fonts count="2"><font><sz val="10"/><name val="Aptos"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF176858"/>'
        '<bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
        '<border><left style="thin"><color rgb="FFD9DFE1"/></left>'
        '<right style="thin"><color rgb="FFD9DFE1"/></right>'
        '<top style="thin"><color rgb="FFD9DFE1"/></top>'
        '<bottom style="thin"><color rgb="FFD9DFE1"/></bottom><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" '
        'borderId="0"/></cellStyleXfs>'
        '<cellXfs count="4">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1">'
        '<alignment vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyAlignment="1">'
        '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyAlignment="1">'
        '<alignment horizontal="right" vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyAlignment="1">'
        '<alignment vertical="center" wrapText="1"/></xf>'
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" '
        'builtinId="0"/></cellStyles>'
        '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" '
        'defaultPivotStyle="PivotStyleMedium9"/></styleSheet>'
    )


def _worksheet_xml(rows: list[list[str]]) -> str:
    max_row = len(rows)
    max_column = len(rows[0]) if rows else 1
    dimension = f"A1:{_column_name(max_column)}{max_row}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="{dimension}"/><sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
        f"{_worksheet_columns(rows)}<sheetData>{_worksheet_rows(rows)}</sheetData>"
        f'<autoFilter ref="{dimension}"/><pageMargins left="0.25" right="0.25" '
        'top="0.5" bottom="0.5" header="0.3" footer="0.3"/></worksheet>'
    )


def tabular_to_xlsx(payload: bytes, media_type: str) -> bytes:
    rows = _parse_table(payload, media_type)
    if len(rows) > MAX_XLSX_ROWS:
        raise SpreadsheetExportError("El archivo tabular supera el límite de filas de Excel")
    workbook = io.BytesIO()
    with ZipFile(workbook, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" '
            'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" '
            'Target="xl/workbook.xml"/>'
            '</Relationships>',
        )
        archive.writestr("xl/workbook.xml", _workbook_xml())
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
            'Target="styles.xml"/>'
            '</Relationships>',
        )
        archive.writestr("xl/styles.xml", _styles_xml())
        archive.writestr("xl/worksheets/sheet1.xml", _worksheet_xml(rows))
    return workbook.getvalue()
